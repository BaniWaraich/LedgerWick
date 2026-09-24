"use server";

/**
 * Linking a document to a payment by hand.
 *
 * spec: docs/workflows/manual-invoice-upload.md §11, §12
 *
 * The escape hatch, and `architecture.md §2.4` makes it mandatory: every automated path
 * has to have one. It is reached when the document could not be read, was not an invoice,
 * or matched nothing -- the three outcomes where the system has nothing to offer and the
 * user knows the answer anyway.
 *
 * Thin, like `reconciliation/actions.ts`: the scope comes from the session, the work is a
 * function in `src/matching`, and what comes back is a revalidated page. The choice of
 * which link function to call is the one decision here, and it follows `domain-model.md
 * §5.1` -- a document that became an invoice links through the invoice, anything else
 * links directly.
 */

import { eq } from "drizzle-orm";

import { revalidatePath } from "next/cache";

import { requireScope } from "../../../auth/workspace";
import { invoiceDocuments } from "../../../db/schema";
import { linkDocument, linkInvoice } from "../../../matching/link";

export type LinkFormState = { error?: string };

export async function linkDocumentAction(
  _previous: LinkFormState,
  formData: FormData,
): Promise<LinkFormState> {
  const scope = await requireScope();

  const documentId = String(formData.get("documentId") ?? "");
  const transactionId = String(formData.get("transactionId") ?? "");

  if (transactionId === "") return { error: "Choose the payment this document belongs to." };

  /*
   * An invoice was built from this document, or it was not.
   *
   * The 1:1 rule constrains invoices, so a document that became one has to link through
   * it -- linking the document directly would leave the invoice unlinked and the
   * reconciliation showing a payment with evidence but no invoice.
   */
  const rows = await scope.select(invoiceDocuments, eq(invoiceDocuments.documentId, documentId));
  const invoiceId = rows[0]?.invoiceId ?? null;

  const outcome =
    invoiceId === null
      ? await linkDocument(scope, documentId, transactionId, "USER_LINKED")
      : await linkInvoice(scope, invoiceId, transactionId, "USER_LINKED");

  if (!outcome.linked) return { error: outcome.reason };

  revalidatePath(`/documents/${documentId}`);
  revalidatePath("/reconciliation");

  return {};
}
