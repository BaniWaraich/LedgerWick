/**
 * Everything one review decision needs, and nothing that would make it for them.
 *
 * spec: docs/workflows/invoice-match-review.md §4, §5, §12
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * ## This module reads
 *
 * `§12` is the boundary, in its own words: "This workflow performs no searching,
 * retrieval, or matching. Those have already happened. Its responsibilities are: present
 * the evidence honestly, capture the user's decision, apply it, and persist only what the
 * decision genuinely supports."
 *
 * So nothing here narrows a set, scores anything, or asks a model. It gathers what
 * `src/matching/` already wrote and arranges it for a person. That is also why it lives
 * outside `src/matching/` -- that module is the one that searches and scores, and folding
 * the two together would make §12 a matter of discipline rather than of structure.
 *
 * ## Reading against the grain
 *
 * Matching stores a candidate as (invoice, transaction) and asks "what did I propose for
 * this invoice". Review asks the opposite: "which documents named this payment". Same
 * rows, read the other way, which is why `invoice_match_candidates_transaction_idx`
 * exists.
 *
 * The evidence reads correctly from either side, because it was always a comparison of two
 * things rather than a statement about one of them.
 *
 * ## No number the user cannot check
 *
 * `§5`: "Confidence is shown as the evidence that produced it. A percentage tells the user
 * nothing they can check; 'the amount matches and the date is the same' tells them
 * everything."
 *
 * `rank` is deliberately absent from `ReviewCandidate`. It orders the list and nothing
 * else, and `candidates.ts` says why the sort key is never persisted: so that no later
 * change can start treating the number the list happened to be sorted by as a measurement.
 * The only confidence this hands the page is `evidence: string[]`. A page cannot render a
 * percentage it was never given.
 */

import { eq, inArray } from "drizzle-orm";

import {
  bankAccounts,
  canonicalTransactions,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  supportingDocuments,
  vendors,
} from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { describeAll, fromStored } from "../matching/evidence";

/** One document proposed for this payment, with the case for it. */
export interface ReviewCandidate {
  readonly invoiceId: string;
  readonly documentId: string;
  readonly filename: string;
  /** GMAIL or MANUAL_UPLOAD — §5 shows the user where a candidate came from. */
  readonly source: string;
  readonly vendorName: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly totalMinor: bigint | null;
  readonly currency: string | null;
  /** The case for this candidate, as sentences. The only confidence here. */
  readonly evidence: string[];
  /** What the reader thought, in its own words. Never a score. */
  readonly modelReason: string | null;
  /** Served through the authorized route; the page never learns a storage key. */
  readonly previewHref: string;
}

/** What the system did, so "we found nothing" is informative rather than a shrug. */
export interface WhatWeDid {
  readonly candidatesConsidered: number;
  /** §7: a rejection is never discarded and never looks like inaction. */
  readonly rejectedPreviously: number;
  /** The bounded read hit its cap, so the shortlist was not everything. */
  readonly truncated: boolean;
  /** Mailboxes searched. Empty until features J and K exist. */
  readonly searchedMailboxes: string[];
}

export interface ReviewContext {
  readonly requirement: {
    readonly id: string;
    readonly state: string;
    readonly reason: string | null;
    readonly businessContext: string | null;
    readonly vendorGuess: string | null;
    /** Already settled, so the page offers no decisions. */
    readonly isResolved: boolean;
    /** Whether "every payment to this vendor" is a real option. */
    readonly canGeneralize: boolean;
  };
  readonly transaction: {
    readonly id: string;
    readonly valueDate: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly description: string;
    readonly account: string;
  };
  readonly whatWeDid: WhatWeDid;
  readonly candidates: ReviewCandidate[];
}

/** The rejected document ids on a requirement, whatever the column actually holds. */
export function rejectedDocuments(requirement: { rejectedDocumentIds: unknown }): string[] {
  const ids = requirement.rejectedDocumentIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The primary document of each invoice, keyed by invoice.
 *
 * `rows.find(isPrimary) ?? rows[0]` is the idiom `link.ts` and `match.ts` both use: an
 * invoice built by `understand.ts` always has a primary, and falling back to the first
 * keeps a hand-assembled row from disappearing.
 */
function primaryDocuments(
  rows: { invoiceId: string; documentId: string; isPrimary: boolean }[],
): Map<string, string> {
  const byInvoice = new Map<string, string>();

  for (const row of rows) {
    const existing = byInvoice.get(row.invoiceId);
    if (existing === undefined || row.isPrimary) byInvoice.set(row.invoiceId, row.documentId);
  }

  return byInvoice;
}

/**
 * Assemble one requirement's review.
 *
 * Returns null for a requirement that does not exist and for one belonging to another
 * workspace, deliberately the same answer. Distinguishing them tells an attacker which ids
 * are real, which is the choice `WorkspaceAccessError` already made.
 */
export async function reviewContext(
  scope: WorkspaceScope,
  requirementId: string,
): Promise<ReviewContext | null> {
  const requirement = await scope.selectOne(
    invoiceRequirements,
    eq(invoiceRequirements.id, requirementId),
  );
  if (requirement === null) return null;

  const transaction = await scope.selectOne(
    canonicalTransactions,
    eq(canonicalTransactions.id, requirement.canonicalTransactionId),
  );
  // A requirement cascades with its transaction, so this is unreachable in practice. It
  // is not worth a throw: a review screen that cannot show the payment has nothing to say.
  if (transaction === null) return null;

  const account = await scope.selectOne(
    bankAccounts,
    eq(bankAccounts.id, transaction.bankAccountId),
  );

  const rows = await scope.select(
    invoiceMatchCandidates,
    eq(invoiceMatchCandidates.canonicalTransactionId, transaction.id),
  );

  const invoiceIds = [...new Set(rows.map((row) => row.invoiceId))];

  const [proposed, joins] = await Promise.all([
    invoiceIds.length === 0
      ? Promise.resolve([])
      : scope.select(invoices, inArray(invoices.id, invoiceIds)),
    invoiceIds.length === 0
      ? Promise.resolve([])
      : scope.select(invoiceDocuments, inArray(invoiceDocuments.invoiceId, invoiceIds)),
  ]);

  const documentByInvoice = primaryDocuments(joins);
  const documentIds = [...new Set(documentByInvoice.values())];
  const vendorIds = proposed
    .map((invoice) => invoice.vendorId)
    .filter((id): id is string => id !== null);

  const [documents, vendorRows] = await Promise.all([
    documentIds.length === 0
      ? Promise.resolve([])
      : scope.select(supportingDocuments, inArray(supportingDocuments.id, documentIds)),
    vendorIds.length === 0
      ? Promise.resolve([])
      : scope.select(vendors, inArray(vendors.id, vendorIds)),
  ]);

  const invoiceById = new Map(proposed.map((invoice) => [invoice.id, invoice]));
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const vendorById = new Map(vendorRows.map((vendor) => [vendor.id, vendor]));
  const rejected = new Set(rejectedDocuments(requirement));

  const candidates: ReviewCandidate[] = [];
  let rejectedPreviously = 0;

  for (const row of [...rows].sort((a, b) =>
    a.rank === b.rank ? a.createdAt.getTime() - b.createdAt.getTime() : a.rank - b.rank,
  )) {
    const invoice = invoiceById.get(row.invoiceId);
    const documentId = documentByInvoice.get(row.invoiceId);
    if (invoice === undefined || documentId === undefined) continue;

    /*
     * Already rejected: counted, never shown.
     *
     * Showing it again asks the user something they have answered. Dropping it silently
     * would make §7's "rejection is evidence" invisible -- the screen would look as though
     * the system simply found less.
     */
    if (rejected.has(documentId)) {
      rejectedPreviously += 1;
      continue;
    }

    const document = documentById.get(documentId);
    if (document === undefined) continue;

    candidates.push({
      invoiceId: invoice.id,
      documentId,
      filename: document.filename,
      source: document.source,
      vendorName: invoice.vendorId ? (vendorById.get(invoice.vendorId)?.name ?? null) : null,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      totalMinor: invoice.totalMinor,
      currency: invoice.currency,
      evidence: describeAll(fromStored(row.evidence)),
      modelReason: row.modelReason,
      previewHref: `/api/documents/${documentId}`,
    });
  }

  return {
    requirement: {
      id: requirement.id,
      state: requirement.state,
      reason: requirement.reason,
      businessContext: requirement.businessContext,
      vendorGuess: requirement.vendorGuess,
      isResolved: requirement.resolutionMethod !== null,
      // "Every payment to this vendor" needs a vendor to key the fact on. A narration that
      // was a reference number and nothing else gives none, and offering a choice that
      // silently does nothing is worse than not offering it.
      canGeneralize: (requirement.vendorGuess ?? "").trim() !== "",
    },
    transaction: {
      id: transaction.id,
      valueDate: transaction.valueDate,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      description: transaction.description,
      account: account ? `${account.bankName} ${account.accountIdentifier}` : "Unknown account",
    },
    whatWeDid: {
      candidatesConsidered: rows.length,
      rejectedPreviously,
      truncated: rows.some((row) => row.truncated),
      // Nothing records a search, because retrieval is features J and K. Saying "no
      // mailboxes" is honest; inventing a window would not be.
      searchedMailboxes: [],
    },
    candidates,
  };
}
