/**
 * The transactions an invoice might have paid for, narrowed without asking a model.
 *
 * spec: docs/workflows/manual-invoice-upload.md §8 · docs/architecture.md §10 Stage 1
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * ## The rule this file exists to keep
 *
 * `§8`: "The system should not ask an LLM to search the entire bank statement for a
 * matching transaction." `phase-1.md §7 G` repeats it as a completion condition. The
 * reason is not only cost. A model asked to search has to be trusted about what it did not
 * find, and there is no way to check that claim -- whereas a query has a `where` clause
 * anyone can read, and a transaction it excluded was excluded for a stated reason.
 *
 * So the narrowing here is entirely deterministic, and what reaches the model later is a
 * handful of rows with a rank already on them.
 *
 * ## Why the set is bounded three times over
 *
 * The date window bounds it in principle: a payment lands near the invoice it settles.
 * `CANDIDATE_FETCH_CAP` bounds the read when that assumption is wrong for some workspace
 * nobody anticipated, and it bounds it at the database rather than afterwards, because a
 * caller that fetches everything and slices has still paid for everything.
 * `CANDIDATES_SHOWN_TO_MODEL` bounds what the prompt ever sees.
 *
 * When the cap bites, the set carries `truncated`. That matters more than it looks: a
 * shortlist presented as exhaustive is a lie the user cannot detect, and `§10`'s "no
 * reliable match" outcome reads completely differently if the system never looked at
 * everything.
 *
 * ## Transactions that already hold an invoice are not offered
 *
 * `invoices_transaction_idx` would refuse the write anyway (invariant 9). Excluding them
 * here means the refusal is never reached -- proposing a transaction the system could not
 * link to if the user chose it is offering the user a dead end.
 */

import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";

import { canonicalTransactions, invoiceRequirements, invoices, vendorAliases } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import {
  evidenceFor,
  vendorKeyAppearsIn,
  type Evidence,
  type InvoiceFacts,
  type TransactionFacts,
  type VendorAgreement,
} from "./evidence";
import {
  CANDIDATE_DAYS_AFTER,
  CANDIDATE_DAYS_BEFORE,
  CANDIDATE_FETCH_CAP,
  CANDIDATES_SHOWN_TO_MODEL,
} from "./thresholds";

/** One transaction proposed for an invoice, with the facts that put it there. */
export interface Candidate {
  readonly transaction: TransactionFacts;
  readonly evidence: Evidence[];
  /** Deterministic order, 0 best. */
  readonly rank: number;
}

export interface CandidateSet {
  readonly candidates: Candidate[];
  /** The bounded read hit its cap, so this is not everything that could have matched. */
  readonly truncated: boolean;
}

const EMPTY: CandidateSet = { candidates: [], truncated: false };

/** Shift an ISO date by whole days, staying in UTC. */
function shiftDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * How strongly one candidate's evidence supports it, for ordering only.
 *
 * This is a sort key and it is not a confidence. Nothing decides from it -- `decide.ts`
 * reads the evidence itself -- and it is deliberately not persisted, so that no later
 * change can start treating the number the list happened to be sorted by as a measurement
 * of anything (`0011`).
 */
function strength(evidence: readonly Evidence[]): number {
  let score = 0;

  for (const item of evidence) {
    switch (item.kind) {
      case "AMOUNT":
        if (item.agreement === "EXACT") score += 100;
        else if (item.agreement === "NEAR") score += 40;
        else if (item.agreement === "FX_BAND") score += 20;
        break;
      case "VENDOR":
        if (item.agreement === "RESOLVED") score += 80;
        else if (item.agreement === "ALIAS") score += 70;
        else if (item.agreement === "NORMALIZED_CONTAINS") score += 50;
        break;
      case "DATE":
        if (item.agreement === "SAME_DAY") score += 30;
        else if (item.agreement === "WITHIN_WINDOW") score += 15;
        break;
      case "INVOICE_NUMBER":
        if (item.agreement === "IN_EXTERNAL_REFERENCE") score += 90;
        else if (item.agreement === "IN_DESCRIPTION") score += 60;
        break;
      case "CURRENCY":
        if (item.agreement === "SAME") score += 10;
        break;
    }
  }

  return score;
}

/**
 * Whether a candidate is worth showing at all.
 *
 * A transaction that agrees on neither amount nor vendor is in the window by coincidence.
 * Keeping it would pad the shortlist with rows whose only claim is that they happened
 * nearby, and a shortlist whose tail is noise teaches the user to stop reading it.
 */
function worthShowing(evidence: readonly Evidence[]): boolean {
  const amount = evidence.find((e) => e.kind === "AMOUNT");
  const vendor = evidence.find((e) => e.kind === "VENDOR");

  const amountSays = amount?.kind === "AMOUNT" && amount.agreement !== "DIFFERENT";
  const vendorSays = vendor?.kind === "VENDOR" && vendor.agreement !== "NONE";

  return amountSays || vendorSays;
}

/** The vendor names this workspace already knows for this invoice's vendor. */
async function knownAliases(scope: WorkspaceScope, vendorId: string | null) {
  if (vendorId === null) return [];
  return scope.select(vendorAliases, eq(vendorAliases.vendorId, vendorId));
}

/**
 * Which transactions in a set already carry an invoice.
 *
 * One bounded read keyed on the ids just fetched, in the shape `promote.ts` uses: the
 * alternative is a query per candidate, which is correct and turns a handful of rows into
 * a handful of round trips.
 */
async function alreadyInvoiced(
  scope: WorkspaceScope,
  transactionIds: string[],
  exceptInvoiceId: string,
): Promise<Set<string>> {
  if (transactionIds.length === 0) return new Set();

  const rows = await scope.select(
    invoices,
    and(
      inArray(invoices.canonicalTransactionId, transactionIds),
      // Not this invoice's own link. Re-running on a linked invoice must find its own
      // transaction still available, or a retry would report it as taken by a stranger.
      ne(invoices.id, exceptInvoiceId),
    ),
  );

  return new Set(rows.map((row) => row.canonicalTransactionId).filter((id): id is string => !!id));
}

/**
 * Which of these transactions the user has already said this document is not for.
 *
 * `invoice-match-review.md §7`: rejecting every candidate records the rejection "so that a
 * later run does not present them again", and "rejection is evidence -- it should never be
 * discarded, and it should never be treated as the user having taken no action."
 *
 * The rejection lives on the requirement rather than on the candidate row, and that is the
 * only place it could live: `recordCandidates` deletes and re-inserts the whole candidate
 * set on every run, so a flag there would be destroyed by the next match.
 *
 * Suppression is per pair, not per transaction. A user saying "this receipt is not for that
 * payment" has said nothing about any other document, and a transaction that rejected one
 * document is still a perfectly good candidate for the next one.
 *
 * One bounded read keyed on the ids just fetched, the same shape as `alreadyInvoiced`.
 */
async function rejectedFor(
  scope: WorkspaceScope,
  transactionIds: string[],
  documentId: string | null,
): Promise<Set<string>> {
  if (documentId === null || transactionIds.length === 0) return new Set();

  const rows = await scope.select(
    invoiceRequirements,
    inArray(invoiceRequirements.canonicalTransactionId, transactionIds),
  );

  const rejected = new Set<string>();
  for (const row of rows) {
    // jsonb, so what comes back is whatever was written. A column holding something
    // unexpected must not throw while someone is waiting for a shortlist.
    const ids = Array.isArray(row.rejectedDocumentIds) ? row.rejectedDocumentIds : [];
    if (ids.includes(documentId)) rejected.add(row.canonicalTransactionId);
  }

  return rejected;
}

/**
 * Propose the transactions this invoice might have paid for.
 *
 * Returns an empty set rather than throwing when the invoice carries no date: the window
 * is derived from that date, and without one there is nothing to search but everything.
 * `hasMinimumFields` makes that unreachable today, and it is one relaxation away from
 * being an unbounded scan, so it is handled here rather than assumed away.
 */
export async function generateCandidates(
  scope: WorkspaceScope,
  invoice: InvoiceFacts & { id: string; documentId: string | null },
): Promise<CandidateSet> {
  if (invoice.invoiceDate === null) return EMPTY;

  const from = shiftDays(invoice.invoiceDate, -CANDIDATE_DAYS_BEFORE);
  const to = shiftDays(invoice.invoiceDate, CANDIDATE_DAYS_AFTER);

  const rows = await scope.select(
    canonicalTransactions,
    and(
      gte(canonicalTransactions.valueDate, from),
      lte(canonicalTransactions.valueDate, to),
      // An invoice is a charge. domain-model.md §11.1 puts incoming credits outside V1,
      // and identify.ts already refuses a requirement for one; matching inherits that
      // boundary rather than re-deciding it.
      eq(canonicalTransactions.direction, "DEBIT"),
    ),
    CANDIDATE_FETCH_CAP,
  );

  const truncated = rows.length === CANDIDATE_FETCH_CAP;
  if (rows.length === 0) return EMPTY;

  const transactionIds = rows.map((row) => row.id);
  const taken = await alreadyInvoiced(scope, transactionIds, invoice.id);
  const rejected = await rejectedFor(scope, transactionIds, invoice.documentId);
  const aliases = await knownAliases(scope, invoice.vendorId);
  const aliasKeys = aliases.map((alias) => alias.aliasNormalized);
  const confirmed = new Set(
    aliases.filter((alias) => alias.confirmed).map((alias) => alias.aliasNormalized),
  );

  const scored: { candidate: Omit<Candidate, "rank">; strength: number }[] = [];

  for (const row of rows) {
    if (taken.has(row.id)) continue;
    // The user has seen this document against this payment and said no. §7.
    if (rejected.has(row.id)) continue;

    const transaction: TransactionFacts = {
      id: row.id,
      valueDate: row.valueDate,
      amountMinor: row.amountMinor,
      currency: row.currency,
      description: row.description,
      descriptionNormalized: row.descriptionNormalized,
      externalReference: row.externalReference,
    };

    const evidence = evidenceFor(
      invoice,
      transaction,
      { agreement: vendorAgreement(invoice, transaction, aliasKeys, confirmed) },
      { before: CANDIDATE_DAYS_BEFORE, after: CANDIDATE_DAYS_AFTER },
    );

    if (!worthShowing(evidence)) continue;

    scored.push({ candidate: { transaction, evidence }, strength: strength(evidence) });
  }

  /*
   * Ties break on the transaction id rather than on whatever order the rows arrived in.
   * Two identical candidates must rank the same way on every run, or a retry would
   * present a different "best" match than the attempt before it.
   */
  scored.sort((a, b) =>
    b.strength === a.strength
      ? a.candidate.transaction.id.localeCompare(b.candidate.transaction.id)
      : b.strength - a.strength,
  );

  return {
    candidates: scored
      .slice(0, CANDIDATES_SHOWN_TO_MODEL)
      .map(({ candidate }, rank) => ({ ...candidate, rank })),
    truncated,
  };
}

/** How the invoice's vendor shows up in this transaction's description, if it does. */
function vendorAgreement(
  invoice: InvoiceFacts,
  transaction: TransactionFacts,
  aliasKeys: readonly string[],
  confirmed: ReadonlySet<string>,
): VendorAgreement {
  const hit = aliasKeys.find((key) => vendorKeyAppearsIn([key], transaction.descriptionNormalized));

  // A confirmed alias is Business Knowledge -- a user said so. An inferred one is a guess
  // the extraction made, and architecture.md §11 keeps the two apart, so the evidence says
  // which kind was used rather than flattening both into "the vendor matched".
  if (hit !== undefined) return confirmed.has(hit) ? "RESOLVED" : "ALIAS";

  if (vendorKeyAppearsIn(invoice.vendorKeys, transaction.descriptionNormalized)) {
    return "NORMALIZED_CONTAINS";
  }

  return "NONE";
}
