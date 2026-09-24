/**
 * Two documents that may be the same invoice, put side by side.
 *
 * spec: docs/workflows/invoice-match-review.md §8 · docs/domain-model.md Rule 11
 *
 * `§8`: "When the entry point is a suspected duplicate, the question is different: not
 * 'which transaction', but 'are these the same invoice'."
 *
 * ## This file shows; it does not judge
 *
 * `src/matching/duplicates.ts` decides whether two invoices are suspected duplicates, with
 * its own normalizers and its own threshold. This one renders the comparison the user is
 * shown and applies the answer they give. The `agrees` flag below is what a person can see
 * for themselves by reading two documents — it is not a second opinion about the same
 * question, and nothing here may become one. Two files answering "are these the same"
 * would be exactly the drift `link.ts` warns about.
 *
 * ## Nothing is deleted that anybody uploaded
 *
 * `§8`: "both files are retained as documents of one Invoice, and the user chooses which is
 * primary. Nothing is deleted — the user asked to deduplicate a record, not to destroy a
 * file."
 *
 * So `keepOne` moves the document joins onto the surviving invoice and then removes the
 * redundant `invoices` row. Every `supporting_documents` row and every stored blob is
 * untouched. An Invoice is a record derived from a document; the document is the thing
 * that cannot be recreated.
 */

import { and, eq } from "drizzle-orm";

import { invoiceDocuments, invoices } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";

/** One field of the two invoices, and whether a reader would call them the same. */
export interface FieldComparison {
  readonly field: "Vendor" | "Invoice number" | "Date" | "Amount";
  readonly existing: string | null;
  readonly incoming: string | null;
  /** Null where one side has nothing to compare — neither agreement nor disagreement. */
  readonly agrees: boolean | null;
}

/** One invoice, reduced to what the comparison shows. */
export interface ComparableInvoice {
  readonly vendorName: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly amount: string | null;
}

export interface DuplicateComparison {
  readonly existingInvoiceId: string;
  readonly incomingInvoiceId: string;
  readonly existingDocumentId: string | null;
  readonly incomingDocumentId: string | null;
  /** Why the system suspects it, in the words matching recorded. */
  readonly reason: string | null;
  readonly fields: FieldComparison[];
}

/** Case and punctuation only — the same formatting-not-meaning line kept everywhere else. */
function same(a: string | null, b: string | null): boolean | null {
  if (a === null || b === null) return null;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalize(a) === normalize(b);
}

/**
 * The two invoices, field by field, for a person to read.
 *
 * Display only. Every row shows both values so the disagreements are as visible as the
 * agreements — `§8`'s layout puts them in two columns for exactly that reason.
 */
export function compareInvoices(
  existing: ComparableInvoice,
  incoming: ComparableInvoice,
): FieldComparison[] {
  return [
    {
      field: "Vendor",
      existing: existing.vendorName,
      incoming: incoming.vendorName,
      agrees: same(existing.vendorName, incoming.vendorName),
    },
    {
      field: "Invoice number",
      existing: existing.invoiceNumber,
      incoming: incoming.invoiceNumber,
      agrees: same(existing.invoiceNumber, incoming.invoiceNumber),
    },
    {
      field: "Date",
      existing: existing.invoiceDate,
      incoming: incoming.invoiceDate,
      agrees: same(existing.invoiceDate, incoming.invoiceDate),
    },
    {
      field: "Amount",
      existing: existing.amount,
      incoming: incoming.amount,
      agrees: same(existing.amount, incoming.amount),
    },
  ];
}

export type MergeOutcome =
  { readonly merged: true } | { readonly merged: false; readonly reason: string };

/**
 * They are the same invoice: keep one record and both files.
 *
 * The surviving invoice is the one already on file. Its documents gain the newcomer's, the
 * user says which is primary, and the redundant record goes.
 */
export async function keepOne(
  scope: WorkspaceScope,
  duplicateInvoiceId: string,
  primaryDocumentId: string,
): Promise<MergeOutcome> {
  const duplicate = await scope.selectOne(invoices, eq(invoices.id, duplicateInvoiceId));
  if (duplicate === null) return { merged: false, reason: "That invoice is no longer here." };

  const keptId = duplicate.suspectedDuplicateOfInvoiceId;
  if (keptId === null) return { merged: false, reason: "That is not marked as a duplicate." };

  /*
   * A duplicate is never auto-linked -- `decide.ts` blocks it on the flag -- so this is
   * unreachable unless a user linked it by hand in another tab. Refusing is the safe
   * answer: merging would move documents off an invoice that is settled on a payment.
   */
  if (duplicate.canonicalTransactionId !== null) {
    return { merged: false, reason: "That invoice is already linked to a payment." };
  }

  const kept = await scope.selectOne(invoices, eq(invoices.id, keptId));
  if (kept === null) return { merged: false, reason: "The original invoice is no longer here." };

  // The joins move first. Once they point at the kept invoice, deleting the duplicate row
  // cascades onto nothing -- which is what keeps "nothing is deleted" true of the files.
  await scope.update(
    invoiceDocuments,
    { invoiceId: keptId },
    eq(invoiceDocuments.invoiceId, duplicateInvoiceId),
  );

  const joins = await scope.select(invoiceDocuments, eq(invoiceDocuments.invoiceId, keptId));

  for (const join of joins) {
    const shouldBePrimary = join.documentId === primaryDocumentId;
    if (join.isPrimary === shouldBePrimary) continue;

    await scope.update(
      invoiceDocuments,
      { isPrimary: shouldBePrimary },
      and(eq(invoiceDocuments.invoiceId, keptId), eq(invoiceDocuments.documentId, join.documentId)),
    );
  }

  await scope.delete(invoices, eq(invoices.id, duplicateInvoiceId));

  return { merged: true };
}

/**
 * They are different invoices after all.
 *
 * `§8`: "a separate Invoice is created and matched independently." The invoice already
 * exists, so what is needed is to clear the flag and let matching run again — `decide.ts`
 * suppressed the automatic link on the flag alone, so clearing it without re-running would
 * leave the invoice permanently unmatched.
 *
 * Re-running is the caller's to do, because sending an event belongs at the edge.
 */
export async function keepBoth(
  scope: WorkspaceScope,
  duplicateInvoiceId: string,
): Promise<MergeOutcome> {
  const duplicate = await scope.selectOne(invoices, eq(invoices.id, duplicateInvoiceId));
  if (duplicate === null) return { merged: false, reason: "That invoice is no longer here." };
  if (duplicate.suspectedDuplicateOfInvoiceId === null) {
    return { merged: false, reason: "That is not marked as a duplicate." };
  }

  await scope.update(
    invoices,
    { suspectedDuplicateOfInvoiceId: null, duplicateReason: null },
    eq(invoices.id, duplicateInvoiceId),
  );

  return { merged: true };
}
