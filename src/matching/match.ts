/**
 * Working out which payment an invoice was for.
 *
 * spec: docs/workflows/manual-invoice-upload.md §8-§10, §13, §14
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * Sequencing and persistence only. Every judgment in here belongs to a file that does one
 * thing: `candidates.ts` narrows, `evidence.ts` observes, `duplicates.ts` compares,
 * `decide.ts` decides, `link.ts` writes. This orders them and records what happened.
 *
 * ## The order is not arbitrary
 *
 * A document that arrived already bound to a payment short-circuits everything. The user
 * answered the question matching exists to answer, and `phase-1.md §7 G` requires that
 * entry to skip matching entirely rather than compute a shortlist and agree with them.
 *
 * Then duplicates, before candidates. An invoice that is a second copy of one already on
 * file must not be auto-linked to anything, so establishing that first means the decision
 * never has to be undone -- and `decide.ts` takes it as a term rather than being told
 * afterwards.
 *
 * ## Running it twice
 *
 * Idempotent by what it finds, as `understandDocument` is. An invoice already carrying a
 * transaction is finished. The candidate set is replaced rather than added to, so a retry
 * that died after writing it produces the same rows rather than double.
 *
 * ## Why an unmatched invoice is not a failure
 *
 * `NOT_FOUND` and `NEEDS_REVIEW` are states the user acts on, not errors. A run that ends
 * in either did its job. The only thing that throws out of here is infrastructure, which
 * Inngest retries -- `architecture.md §15`'s line between recoverable and not.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import {
  canonicalTransactions,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  supportingDocuments,
  vendorAliases,
  vendors,
} from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { generateCandidates, type Candidate } from "./candidates";
import type { AdjudicateMatch, JudgeSameInvoice } from "./contracts";
import { decideOutcome, type Adjudication } from "./decide";
import { describeAll, toStored, type InvoiceFacts } from "./evidence";
import { findDuplicate, flagDuplicate } from "./duplicates";
import { linkInvoice } from "./link";
import { vendorLookupKeys } from "../documents/vendors";

export interface MatchDeps {
  readonly adjudicate: AdjudicateMatch;
  readonly judgeSameInvoice: JudgeSameInvoice;
  /** Formats an amount for the model. Injected so this file stays free of `server-only`. */
  readonly formatAmount: (minor: bigint | null, currency: string | null) => string | null;
}

export interface MatchOutcome {
  /** What happened, in the vocabulary the outcome screen renders. */
  readonly outcome: "LINKED" | "NEEDS_REVIEW" | "NOT_FOUND" | "DUPLICATE" | "SKIPPED";
  readonly transactionId: string | null;
  /** How many transactions were proposed. Zero is a meaningful answer. */
  readonly candidates: number;
  readonly reason: string;
}

/** The invoice, its vendor's names, and the document it was read from. */
async function load(scope: WorkspaceScope, invoiceId: string) {
  const invoice = await scope.selectOne(invoices, eq(invoices.id, invoiceId));
  if (invoice === null) return null;

  const vendor =
    invoice.vendorId === null
      ? null
      : await scope.selectOne(vendors, eq(vendors.id, invoice.vendorId));

  const aliases =
    invoice.vendorId === null
      ? []
      : await scope.select(vendorAliases, eq(vendorAliases.vendorId, invoice.vendorId));

  const documents = await scope.select(invoiceDocuments, eq(invoiceDocuments.invoiceId, invoiceId));
  const primary = documents.find((row) => row.isPrimary) ?? documents[0];

  const facts: InvoiceFacts & { id: string } = {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    totalMinor: invoice.totalMinor,
    currency: invoice.currency,
    vendorId: invoice.vendorId,
    vendorName: vendor?.name ?? null,
    // The names on the document, normalized. An alias row already holds its own key.
    vendorKeys: vendorLookupKeys([vendor?.name, vendor?.legalName, ...aliases.map((a) => a.alias)]),
  };

  return { invoice, facts, documentId: primary?.documentId ?? null };
}

/**
 * Replace this invoice's candidate set.
 *
 * Delete then insert, rather than upsert: the set is the working-out of one run, and a run
 * that now proposes three transactions where the last proposed five should leave three.
 * Keeping the stale two would put transactions in front of the user that this run had
 * already ruled out.
 */
async function recordCandidates(
  scope: WorkspaceScope,
  invoiceId: string,
  candidates: Candidate[],
  truncated: boolean,
  adjudication: Adjudication | null,
): Promise<void> {
  await scope.delete(invoiceMatchCandidates, eq(invoiceMatchCandidates.invoiceId, invoiceId));

  if (candidates.length === 0) return;

  await scope.insert(
    invoiceMatchCandidates,
    candidates.map((candidate) => ({
      invoiceId,
      canonicalTransactionId: candidate.transaction.id,
      rank: candidate.rank,
      evidence: toStored(candidate.evidence),
      truncated,
      modelVerdict:
        adjudication !== null && adjudication.candidateRank === candidate.rank
          ? adjudication.verdict
          : null,
      modelReason:
        adjudication !== null && adjudication.candidateRank === candidate.rank
          ? adjudication.reason
          : null,
    })),
  );
}

/** A requirement state this run is allowed to write. */
type RunState = "IDENTIFIED" | "EVALUATING" | "NEEDS_REVIEW" | "NOT_FOUND";

/**
 * Move one requirement to a state the user acts on.
 *
 * One, not a set. A run is one decision about one document, and the transaction it
 * proposes is the only one it has assessed -- see the anchor in `matchInvoice`.
 */
async function setRequirementState(
  scope: WorkspaceScope,
  transactionId: string | null,
  state: RunState,
): Promise<void> {
  if (transactionId === null) return;

  await scope.update(
    invoiceRequirements,
    { state, updatedAt: new Date() },
    and(
      eq(invoiceRequirements.canonicalTransactionId, transactionId),
      // A resolved requirement is settled. Matching a later document must not reopen a
      // question the user already answered -- and this is also what stops the restore
      // below from undoing a link that succeeded.
      isNull(invoiceRequirements.resolutionMethod),
    ),
  );
}

/** The state the requirement on this transaction is in, if there is one. */
async function requirementState(
  scope: WorkspaceScope,
  transactionId: string | null,
): Promise<RunState | null> {
  if (transactionId === null) return null;

  const requirement = await scope.selectOne(
    invoiceRequirements,
    eq(invoiceRequirements.canonicalTransactionId, transactionId),
  );

  return (requirement?.state as RunState | undefined) ?? null;
}

/** The transaction a document was bound to on the way in, if it was. */
async function boundTransaction(
  scope: WorkspaceScope,
  documentId: string | null,
): Promise<string | null> {
  if (documentId === null) return null;
  const document = await scope.selectOne(
    supportingDocuments,
    eq(supportingDocuments.id, documentId),
  );
  return document?.canonicalTransactionId ?? null;
}

/**
 * Match one invoice.
 *
 * Returns rather than throws for every outcome the domain has a word for. The caller is a
 * background function, and `architecture.md §15` wants "could not match" recorded as state
 * and infrastructure failure left to retry.
 */
export async function matchInvoice(
  scope: WorkspaceScope,
  invoiceId: string,
  deps: MatchDeps,
): Promise<MatchOutcome> {
  const loaded = await load(scope, invoiceId);

  // Indistinguishable from "no such invoice". The same choice WorkspaceAccessError made.
  if (loaded === null) {
    return { outcome: "SKIPPED", transactionId: null, candidates: 0, reason: "No such invoice." };
  }

  const { invoice, facts, documentId } = loaded;

  if (invoice.canonicalTransactionId !== null) {
    return {
      outcome: "LINKED",
      transactionId: invoice.canonicalTransactionId,
      candidates: 0,
      reason: "Already linked to a payment.",
    };
  }

  /*
   * The user already answered the question.
   *
   * `invoice-match-review.md §6`: entering from review pre-binds the transaction, and
   * "the matching stage is skipped entirely -- the user has already answered the question
   * matching exists to answer." Generating a shortlist here and agreeing with them would
   * be work whose only possible outcome is to be overruled.
   */
  const bound = await boundTransaction(scope, documentId);
  if (bound !== null) {
    const linked = await linkInvoice(scope, invoiceId, bound, "USER_LINKED");
    return linked.linked
      ? {
          outcome: "LINKED",
          transactionId: bound,
          candidates: 0,
          reason: "You chose this payment.",
        }
      : { outcome: "NEEDS_REVIEW", transactionId: null, candidates: 0, reason: linked.reason };
  }

  const duplicate = await findDuplicate(scope, invoice, {
    judge: deps.judgeSameInvoice,
    vendorName: facts.vendorName,
  });

  if (duplicate !== null) await flagDuplicate(scope, invoiceId, duplicate);

  const { candidates, truncated } = await generateCandidates(scope, { ...facts, documentId });

  /*
   * The one requirement this run is entitled to move.
   *
   * A run is one decision about one document, and the best candidate is the only
   * transaction it actually proposes. Marking all five would put five rows in the action
   * queue for one decision, and resolving the right one would leave four false alarms the
   * user has to dismiss by hand.
   *
   * Nothing is lost by narrowing. Feature H enters by requirement and reads candidates by
   * `canonical_transaction_id`, so a document that ranked some other transaction second is
   * still shown, with its evidence, on that transaction's review screen. Only the state
   * transition is narrowed; the evidence stays discoverable from every transaction it
   * names.
   *
   * `decide.ts` allows an automatic link only when exactly one candidate survives, so the
   * anchor and the transaction that gets linked are always the same row.
   */
  const anchor = candidates[0]?.transaction.id ?? null;
  const before = await requirementState(scope, anchor);

  try {
    await setRequirementState(scope, anchor, "EVALUATING");

    const adjudication = await adjudicate(deps, facts, candidates);

    await recordCandidates(scope, invoiceId, candidates, truncated, adjudication);

    const decision = decideOutcome({
      // The in-memory evidence, with amounts still `bigint`. The policy compares them, and
      // the stored form is text -- `toStored` is for the column, not for deciding.
      candidates: candidates.map((candidate) => ({
        rank: candidate.rank,
        evidence: candidate.evidence,
      })),
      adjudication,
      suspectedDuplicate: duplicate !== null,
      truncated,
    });

    if (decision.kind === "AUTO_MATCH") {
      const chosen = candidates[decision.rank];
      const linked = await linkInvoice(scope, invoiceId, chosen.transaction.id, "AUTO_MATCHED");

      if (linked.linked) {
        return {
          outcome: "LINKED",
          transactionId: chosen.transaction.id,
          candidates: candidates.length,
          reason: describeAll(chosen.evidence).join(" · "),
        };
      }

      // Lost the payment between deciding and writing. That is a question for the user, not
      // an error: the evidence was good and the payment is taken.
      await setRequirementState(scope, anchor, "NEEDS_REVIEW");
      return {
        outcome: "NEEDS_REVIEW",
        transactionId: null,
        candidates: candidates.length,
        reason: linked.reason,
      };
    }

    /*
     * No candidate at all.
     *
     * Nothing moves. `NOT_FOUND` means "assessment completed and nothing suitable was
     * established **for this transaction**", and an invoice that found no payment has
     * assessed no transaction -- it is a fact about the invoice. A requirement reaches
     * `NOT_FOUND` when retrieval searched and came back empty, or when the user rejects
     * every candidate in review.
     */
    if (decision.kind === "NO_MATCH") {
      return {
        outcome: duplicate === null ? "NOT_FOUND" : "DUPLICATE",
        transactionId: null,
        candidates: 0,
        reason:
          duplicate?.reason ?? "We couldn't find a payment on your statements that matches this.",
      };
    }

    await setRequirementState(scope, anchor, "NEEDS_REVIEW");
    return {
      outcome: duplicate === null ? "NEEDS_REVIEW" : "DUPLICATE",
      transactionId: null,
      candidates: candidates.length,
      reason: duplicate?.reason ?? decision.blockedBy,
    };
  } catch (error) {
    /*
     * `EVALUATING` must not outlive the run.
     *
     * It means "candidates are being assessed", and a run that has thrown is assessing
     * nothing. Worse, the action queue shows neither `EVALUATING` nor `IDENTIFIED` as
     * needing attention, so a stranded requirement is a payment that silently stops being
     * anybody's problem.
     *
     * A provider timeout is not a verdict. Inngest retries, and the retry should start
     * from the state the first attempt inherited. The `isNull(resolutionMethod)` guard
     * inside `setRequirementState` means this cannot undo a link that did succeed.
     */
    if (before !== null) await setRequirementState(scope, anchor, before);
    throw error;
  }
}

/**
 * Ask the model, unless there is nothing worth asking about.
 *
 * One candidate that already fails a deterministic term still goes up: the answer is
 * recorded beside the candidate and feature H shows it, so a user deciding between a
 * near-miss and nothing has the reader's sentence too.
 *
 * A model that could not answer returns null rather than throwing, because
 * `decide.ts` treats an absent answer as a downgrade to review -- a gateway with no
 * credit must not read as agreement, and must not fail the invoice either.
 */
async function adjudicate(
  deps: MatchDeps,
  facts: InvoiceFacts,
  candidates: Candidate[],
): Promise<Adjudication | null> {
  if (candidates.length === 0) return null;

  const inference = await deps.adjudicate({
    invoice: {
      vendor: facts.vendorName,
      invoiceNumber: facts.invoiceNumber,
      invoiceDate: facts.invoiceDate,
      amount: deps.formatAmount(facts.totalMinor, facts.currency),
    },
    candidates: candidates.map((candidate) => ({
      index: candidate.rank,
      valueDate: candidate.transaction.valueDate,
      amount:
        deps.formatAmount(candidate.transaction.amountMinor, candidate.transaction.currency) ??
        `${candidate.transaction.currency} ${candidate.transaction.amountMinor}`,
      description: candidate.transaction.description,
      evidence: describeAll(candidate.evidence),
    })),
  });

  if (!inference.ok) return null;

  return {
    candidateRank: inference.value.candidate,
    verdict: inference.value.verdict,
    reason: inference.value.reason,
  };
}

/** Transactions with no invoice, for the manual-link picker. Newest first. */
export async function linkableTransactions(scope: WorkspaceScope, limit = 50) {
  const taken = await scope.select(invoices, isNotNull(invoices.canonicalTransactionId));
  const takenIds = new Set(
    taken.map((row) => row.canonicalTransactionId).filter((id): id is string => id !== null),
  );

  const rows = await scope.select(
    canonicalTransactions,
    eq(canonicalTransactions.direction, "DEBIT"),
  );

  return rows
    .filter((row) => !takenIds.has(row.id))
    .sort((a, b) => b.valueDate.localeCompare(a.valueDate))
    .slice(0, limit);
}
