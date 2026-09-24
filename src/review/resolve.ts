/**
 * Applying the decision a user made about one requirement.
 *
 * spec: docs/workflows/invoice-match-review.md §5, §6, §7, §9, §11
 *
 * ## What this file decides, and what it does not
 *
 * It decides *which* funnel entry point a decision calls. It never performs a resolution
 * write itself: every write to `invoice_requirements.resolution_method` happens in
 * `src/matching/link.ts`, which is where the `isNull(resolutionMethod)` guard lives. A
 * second copy of that guard here would be a second place to get it subtly wrong, and the
 * one that was wrong would be whichever was written last.
 *
 * Rejection is the exception, and only because it resolves nothing. `§11`: every path
 * either resolves the requirement or returns it to the action queue, and rejecting all
 * candidates is the second kind.
 *
 * ## Nothing here throws for an outcome the domain has a word for
 *
 * Already resolved, no such requirement, another workspace's requirement, and a payment
 * that was taken between reading and writing are all ordinary. A user pressing a button
 * twice is the common case, not an error. Each function returns a result the screen can
 * render, in the register `LinkOutcome` established.
 *
 * ## What is learned (§9)
 *
 * | Decision | Learned |
 * | --- | --- |
 * | Confirmed a candidate | The vendor alias, confirmed -- in `learning.ts` |
 * | No document needed, for this vendor | The pattern, as Business Knowledge |
 * | No document needed, this payment only | Nothing |
 * | Rejected every candidate | Nothing about the vendor |
 *
 * That last row is `§9`'s own: "Nothing about the vendor; only that these candidates were
 * wrong." A rejection says the system proposed badly, not that the vendor is unusual.
 */

import { eq } from "drizzle-orm";

import { invoiceDocuments, invoiceRequirements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { linkDocument, linkInvoice, resolveWithoutDocument } from "../matching/link";
import { learn, normalizeVendor, VENDOR } from "../requirements/knowledge";
import { candidateDocumentIds, rejectedDocuments } from "./context";

/** What a decision did, or why it did nothing. */
export type ResolveOutcome =
  { readonly resolved: true } | { readonly resolved: false; readonly reason: string };

/** How widely "no document is needed" applies. §9: ask rather than assume. */
export type Breadth = "THIS_PAYMENT" | "THIS_VENDOR";

/** The same answer for a requirement that is absent, settled, or someone else's. */
const NOTHING_TO_DO: ResolveOutcome = {
  resolved: false,
  reason: "That has already been dealt with.",
};

/** The requirement, if it is this workspace's and still open. */
async function openRequirement(scope: WorkspaceScope, requirementId: string) {
  const requirement = await scope.selectOne(
    invoiceRequirements,
    eq(invoiceRequirements.id, requirementId),
  );

  // Absent and already resolved collapse into one answer deliberately: a stale form and a
  // stranger's id should be indistinguishable, and neither is worth an apology.
  if (requirement === null || requirement.resolutionMethod !== null) return null;

  return requirement;
}

/**
 * The user chose one of the candidates the system proposed.
 *
 * `§5`: "Choosing a candidate resolves the requirement with method `USER_CONFIRMED`."
 */
export async function confirmCandidate(
  scope: WorkspaceScope,
  requirementId: string,
  invoiceId: string,
): Promise<ResolveOutcome> {
  const requirement = await openRequirement(scope, requirementId);
  if (requirement === null) return NOTHING_TO_DO;

  const linked = await linkInvoice(
    scope,
    invoiceId,
    requirement.canonicalTransactionId,
    "USER_CONFIRMED",
  );

  return linked.linked ? { resolved: true } : { resolved: false, reason: linked.reason };
}

/**
 * The user picked a document already in the workspace.
 *
 * `§6`: "Used when an invoice was retrieved against the wrong transaction, or covers a
 * payment the system did not connect it to." Resolves `USER_CONFIRMED`.
 *
 * A document that became an Invoice links through the invoice; one that did not links
 * directly. `domain-model.md §5.1` is why, and `documents/actions.ts` already makes the
 * same branch: the one-to-one rule constrains extracted invoices, not arbitrary evidence,
 * so linking the document directly would leave the invoice unlinked and the reconciliation
 * showing a payment with evidence but no invoice.
 *
 * Deliberately does not consult `rejectedDocumentIds`. Rejection suppresses what the system
 * *proposes*; a user who rejected a document and then deliberately picks it has overruled
 * themselves, which is allowed. `§9`: user confirmation is authoritative.
 */
export async function linkExistingDocument(
  scope: WorkspaceScope,
  requirementId: string,
  documentId: string,
): Promise<ResolveOutcome> {
  const requirement = await openRequirement(scope, requirementId);
  if (requirement === null) return NOTHING_TO_DO;

  const joins = await scope.select(invoiceDocuments, eq(invoiceDocuments.documentId, documentId));
  const invoiceId = joins[0]?.invoiceId ?? null;

  const linked =
    invoiceId === null
      ? await linkDocument(scope, documentId, requirement.canonicalTransactionId, "USER_CONFIRMED")
      : await linkInvoice(scope, invoiceId, requirement.canonicalTransactionId, "USER_CONFIRMED");

  return linked.linked ? { resolved: true } : { resolved: false, reason: linked.reason };
}

/**
 * None of the candidates is right.
 *
 * `§7`: "The requirement returns to `NOT_FOUND`, and the rejected candidates are recorded
 * so that a later run does not present them again. Rejection is evidence. It should never
 * be discarded, and it should never be treated as the user having taken no action."
 *
 * Resolves nothing and never touches `resolutionMethod` — `§11` puts this on the "returns
 * it to the action queue" side. The candidate rows are left alone: a later run rebuilds
 * them anyway, and deleting them would be discarding the evidence §7 protects.
 */
export async function rejectAllCandidates(
  scope: WorkspaceScope,
  requirementId: string,
): Promise<ResolveOutcome> {
  const requirement = await openRequirement(scope, requirementId);
  if (requirement === null) return NOTHING_TO_DO;

  const shown = await candidateDocumentIds(scope, requirement.canonicalTransactionId);
  if (shown.length === 0) {
    return { resolved: false, reason: "There is nothing here to reject." };
  }

  // Additive and deduped. Rejecting again after a later run proposed something new must
  // add the new one rather than replace the record of the old.
  const already = rejectedDocuments(requirement);
  const merged = [...already, ...shown.filter((id) => !already.includes(id))];

  await scope.update(
    invoiceRequirements,
    { state: "NOT_FOUND", rejectedDocumentIds: merged, updatedAt: new Date() },
    eq(invoiceRequirements.id, requirementId),
  );

  return { resolved: true };
}

/**
 * The user says this payment needs no supporting document.
 *
 * `§6`: "the single most valuable answer the user can give, because it is the one that
 * stops the system asking again." Resolves `NOT_REQUIRED`.
 *
 * `breadth` is the answer to a question `§9` tells us to ask rather than assume: does this
 * cover one payment or every payment to this vendor? Only `THIS_VENDOR` writes Business
 * Knowledge, and only when there is a payee to key it on.
 *
 * Nothing is re-run afterwards, unlike answering a clarification question. `answer.ts`
 * kicks a reconciliation because the transaction it answered still carries no requirement
 * and needs re-judging. Here the requirement exists and has just been resolved, so a
 * re-run would change nothing about it. Future payments to this vendor are judged with the
 * fact in hand on the next upload, which is the mechanism that was already there.
 */
export async function markNotRequired(
  scope: WorkspaceScope,
  requirementId: string,
  breadth: Breadth,
): Promise<ResolveOutcome> {
  const requirement = await openRequirement(scope, requirementId);
  if (requirement === null) return NOTHING_TO_DO;

  const outcome = await resolveWithoutDocument(scope, requirement.canonicalTransactionId);
  if (!outcome.resolved) return NOTHING_TO_DO;

  if (breadth === "THIS_VENDOR") {
    const key = normalizeVendor(requirement.vendorGuess);

    // No payee to attach it to, so there is nothing that generalizes. The requirement is
    // still resolved -- the same split `answer.ts` makes between recording and learning.
    if (key !== null) {
      await learn(scope, VENDOR, key, {
        vendor: requirement.vendorGuess,
        answer: "No supporting document is needed for payments to this vendor.",
        question: "Does this payment need a supporting document?",
      });
    }
  }

  return { resolved: true };
}
