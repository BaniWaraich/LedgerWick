/**
 * Attaching a document to the payment it is evidence of.
 *
 * spec: docs/workflows/manual-invoice-upload.md §12, §14 · docs/domain-model.md §5.1,
 * invariants 8, 9 and 17
 *
 * ## Why every path comes through here
 *
 * An automatic match, a user choosing a candidate, a user linking by hand, and a document
 * uploaded already bound to a transaction all end in the same three writes: the link, the
 * requirement resolved, the method recorded. Four implementations of that would be four
 * places for the invariant to be checked slightly differently, and the one that got it
 * wrong would be whichever was written last.
 *
 * ## The invariant is the index, not a check here
 *
 * `invoices_transaction_idx` is a partial unique index on `canonical_transaction_id`. This
 * file does not read-then-write to see whether a transaction is free, because between the
 * read and the write it can stop being free -- two matching runs, or a user and a run,
 * racing on one transaction. It writes, and treats a unique violation as the answer.
 *
 * `promote.ts` leans on the canonical identity index for the same reason and says so.
 *
 * ## Two kinds of document
 *
 * `domain-model.md §5.1`: a document classified as an invoice creates an Invoice and the
 * Invoice links to the transaction. A document that is not -- a payment confirmation, a
 * receipt too thin to extract -- links to the transaction directly and resolves the
 * requirement just the same. Only the first is constrained by the one-to-one rule, which
 * is what keeps that rule meaningful: it constrains extracted invoices, not arbitrary
 * evidence.
 */

import { and, eq, isNull } from "drizzle-orm";

import { isUniqueViolation } from "../db/errors";
import { invoiceDocuments, invoiceRequirements, invoices, supportingDocuments } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";

/** How a link came to be. Matches `resolution_method` in docs/state-machines.md §2. */
export type LinkMethod = "AUTO_MATCHED" | "USER_CONFIRMED" | "USER_LINKED";

export type LinkOutcome =
  | { readonly linked: true; readonly requirementResolved: boolean }
  /**
   * Refused, with a reason a screen can show.
   *
   * A refusal, not an exception. Losing a race for a transaction is an ordinary thing for
   * this function to discover, and a 500 would tell the user their upload broke when what
   * actually happened is that the payment already has an invoice.
   */
  | { readonly linked: false; readonly reason: string };

/**
 * Resolve the requirement on this transaction, if there is one.
 *
 * There need not be. `§14`: "An upload with no requirement to resolve — the user uploading
 * an invoice for a transaction the system never flagged — still creates the document and
 * the Invoice." Nothing is missing, so nothing is resolved, and the Missing Invoice Report
 * is unchanged.
 *
 * Scoped to requirements that are not already `RESOLVED` so that re-running cannot rewrite
 * a method the user chose with one a machine did.
 */
async function resolveRequirement(
  scope: WorkspaceScope,
  transactionId: string,
  documentId: string,
  method: LinkMethod,
): Promise<boolean> {
  const updated = await scope.update(
    invoiceRequirements,
    {
      state: "RESOLVED",
      resolutionMethod: method,
      resolvedDocumentId: documentId,
      updatedAt: new Date(),
    },
    and(
      eq(invoiceRequirements.canonicalTransactionId, transactionId),
      isNull(invoiceRequirements.resolutionMethod),
    ),
  );

  return updated.length > 0;
}

/** The document an invoice was primarily read from. */
async function primaryDocumentOf(scope: WorkspaceScope, invoiceId: string): Promise<string | null> {
  const rows = await scope.select(invoiceDocuments, eq(invoiceDocuments.invoiceId, invoiceId));
  const primary = rows.find((row) => row.isPrimary) ?? rows[0];
  return primary?.documentId ?? null;
}

/**
 * Link an invoice to the transaction it was for.
 *
 * Idempotent by what it finds: an invoice already on this transaction is finished, not an
 * error, so a retried workflow reports success rather than a collision with itself.
 */
export async function linkInvoice(
  scope: WorkspaceScope,
  invoiceId: string,
  transactionId: string,
  method: LinkMethod,
): Promise<LinkOutcome> {
  const invoice = await scope.selectOne(invoices, eq(invoices.id, invoiceId));

  // Indistinguishable from "no such invoice", deliberately -- the choice
  // WorkspaceAccessError already made. Telling an attacker which ids are real is telling
  // them something.
  if (invoice === null) return { linked: false, reason: "We couldn't find that invoice." };

  if (invoice.canonicalTransactionId === transactionId) {
    const documentId = await primaryDocumentOf(scope, invoiceId);
    const resolved =
      documentId === null
        ? false
        : await resolveRequirement(scope, transactionId, documentId, method);
    return { linked: true, requirementResolved: resolved };
  }

  if (invoice.canonicalTransactionId !== null) {
    return { linked: false, reason: "That invoice is already linked to another payment." };
  }

  try {
    await scope.update(
      invoices,
      { canonicalTransactionId: transactionId },
      eq(invoices.id, invoiceId),
    );
  } catch (error) {
    // Invariant 9, enforced by the index rather than by a check above it. The transaction
    // was taken between deciding and writing, or was always taken.
    if (isUniqueViolation(error)) {
      return { linked: false, reason: "That payment already has an invoice." };
    }
    throw error;
  }

  const documentId = await primaryDocumentOf(scope, invoiceId);
  const resolved =
    documentId === null
      ? false
      : await resolveRequirement(scope, transactionId, documentId, method);

  return { linked: true, requirementResolved: resolved };
}

/**
 * Link a supporting document that is not an invoice directly to a transaction.
 *
 * `§5.1`'s second branch, and `§11`'s escape hatch: a document the system could not read,
 * or read and found was not an invoice, is still evidence the business has. It resolves
 * the requirement without an Invoice ever existing, and the one-to-one rule is untouched
 * because that rule is about invoices.
 *
 * Invariant 17 is why this is not constrained: a transaction may hold several supporting
 * documents, and only one invoice.
 */
export async function linkDocument(
  scope: WorkspaceScope,
  documentId: string,
  transactionId: string,
  method: LinkMethod,
): Promise<LinkOutcome> {
  const document = await scope.selectOne(
    supportingDocuments,
    eq(supportingDocuments.id, documentId),
  );

  if (document === null) return { linked: false, reason: "We couldn't find that document." };

  await scope.update(
    supportingDocuments,
    { canonicalTransactionId: transactionId },
    eq(supportingDocuments.id, documentId),
  );

  const resolved = await resolveRequirement(scope, transactionId, documentId, method);

  return { linked: true, requirementResolved: resolved };
}
