/**
 * Moving one stored document to whatever it turned out to be.
 *
 * spec: docs/workflows/manual-invoice-upload.md §4–6 and §11
 * spec: docs/workflows/retrieve-invoices.md §11.1
 * states: docs/state-machines.md §3
 * decision: docs/decisions/0010-extraction-returns-locators.md
 *
 * The pipeline both entry paths converge on. `retrieve-invoices.md §11.1` is explicit that
 * "the two entry paths converge here, and neither skips it", and the way that stays true is
 * for this function to know nothing about where its document came from. It takes a
 * document id and a workspace, and it never looks at a canonical transaction, never links
 * anything to one, and never touches an Invoice Requirement. Matching is feature G's and
 * review is feature H's.
 *
 * ## State and classification are two columns
 *
 * `state` records what was **obtained**; `classification` records what is **believed**.
 * `state-machines.md §3` requires classification to stay three-valued and "must not be
 * flattened to a boolean", and the cheapest way to honour that is for the two never to be
 * derived from one another. A document can be `EXTRACTED` while `UNCERTAIN`, and the
 * uncertainty remains visible on its own column for feature H to present.
 *
 * ## Failure is a state or a retry, never both
 *
 * A model that answered unusably has told us something about this document, and it will not
 * improve on a second attempt -- `inferStructure` already made that judgment. That is
 * `UNREADABLE`. A model that never answered has told us something about our infrastructure,
 * so it is rethrown for the workflow to retry, and the document is left mid-state rather
 * than libelled. `state-machines.md §3` records why there is no `FAILED` state to put it in.
 */

import { eq } from "drizzle-orm";

import type { ReadInvoice } from "./contracts";
import type { ExtractPdfText } from "./contracts";
import { hasMinimumFields, invoiceFieldsFrom, type InvoiceFields } from "./fields";
import { readDocumentContent } from "./text";
import { resolveVendor } from "./vendors";
import { invoiceDocuments, invoices, supportingDocuments } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { DocumentStore } from "../storage/document-store";
import { timed } from "../observability/timing";

/** What understanding one document did. */
export interface UnderstandingOutcome {
  /** The state the document ended in, or null when there was no such document to reach. */
  readonly state: "EXTRACTED" | "UNREADABLE" | "NOT_AN_INVOICE" | null;
  /** The invoice this produced, when it produced one. */
  readonly invoiceId: string | null;
  /** Why, in one line, for the log and for a summary screen. */
  readonly reason: string;
}

/** The states a document has already finished in. Reaching one again is not work. */
const TERMINAL = ["EXTRACTED", "UNREADABLE", "NOT_AN_INVOICE"] as const;

const NO_SUCH_DOCUMENT = "no such document in this workspace";
const BYTES_MISSING = "the stored bytes are gone";
const NOT_READABLE = "nothing could be read from this document";
const NO_DETAILS = "the document was read but named no vendor, amount or date";

export interface UnderstandDeps {
  readonly store: DocumentStore;
  readonly extractPdfText: ExtractPdfText;
  readonly read: ReadInvoice;
}

/**
 * Understand one stored supporting document.
 *
 * Idempotent by what it finds, in the shape `src/requirements/identify.ts` uses: a document
 * already in a terminal state is left exactly as it is. `architecture.md §16` names invoice
 * extraction among the workflows that must survive being run twice, and a retry after a
 * timeout that had in fact succeeded is the ordinary case rather than a rare one.
 */
/**
 * Whether this outcome leaves an invoice for feature G to find a payment for.
 *
 * Lives here rather than in the Inngest shell that asks it, because the shell imports a
 * model provider and this has to be reachable from a test that does not.
 *
 * `UNREADABLE` and `NOT_AN_INVOICE` are outcomes rather than failures -- the document
 * stays stored and the user may still link it by hand (`state-machines.md §3`) -- and
 * neither produces an invoice. A null state is a document another attempt already
 * finished, or one that is not this workspace's.
 */
export function leavesAnInvoice(
  outcome: UnderstandingOutcome,
): outcome is UnderstandingOutcome & { invoiceId: string } {
  return outcome.state === "EXTRACTED" && outcome.invoiceId !== null;
}

export async function understandDocument(
  scope: WorkspaceScope,
  documentId: string,
  deps: UnderstandDeps,
): Promise<UnderstandingOutcome> {
  const document = await scope.selectOne(
    supportingDocuments,
    eq(supportingDocuments.id, documentId),
  );

  /*
   * The isolation point, and the only one this function needs.
   *
   * `scope.selectOne` carries the workspace filter, so a document belonging to another
   * workspace is indistinguishable from one that does not exist -- which is what
   * `WorkspaceAccessError` already decided is the right answer, because telling the two
   * apart tells an attacker which ids are real. Everything below acts on this row, so
   * nothing below can reach outside the workspace.
   */
  if (!document) return { state: null, invoiceId: null, reason: NO_SUCH_DOCUMENT };

  if ((TERMINAL as readonly string[]).includes(document.state)) {
    return {
      state: document.state as (typeof TERMINAL)[number],
      invoiceId: await existingInvoiceFor(scope, documentId),
      reason: "already understood",
    };
  }

  await scope.update(
    supportingDocuments,
    { state: "EXTRACTING" },
    eq(supportingDocuments.id, documentId),
  );

  const object = await deps.store.get(document.storageRef);
  if (!object) {
    // The row outlived its bytes. Nothing is retrievable, and no retry changes that.
    return settle(scope, documentId, "UNREADABLE", null, BYTES_MISSING);
  }

  const bytes = await timed(
    "fetch-bytes",
    { documentId },
    async () => new Uint8Array(await new Response(object.stream).arrayBuffer()),
  );

  const content = await timed("read-document", { documentId, bytes: bytes.length }, () =>
    readDocumentContent(bytes, deps.extractPdfText),
  );
  if (!content) return settle(scope, documentId, "UNREADABLE", null, NOT_READABLE);

  await scope.update(
    supportingDocuments,
    { state: "CLASSIFYING" },
    eq(supportingDocuments.id, documentId),
  );

  const inference = await deps.read(
    content.path === "TEXT"
      ? [{ type: "text", text: content.text }]
      : [{ type: "file", data: content.bytes, mediaType: content.mediaType }],
  );

  /*
   * The model answered and the answer was unusable: a refusal, or output that would not fit
   * the schema. `inferStructure` has already distinguished that from never answering at
   * all, which it rethrows. So this is a fact about the document and is recorded as one.
   */
  if (!inference.ok) {
    return settle(scope, documentId, "UNREADABLE", null, inference.reason);
  }

  const reading = inference.value;

  /*
   * The extracted text goes in alongside the reading, so that every span can be checked
   * against it (`0010`). Undefined on the visual path, where there is no text and therefore
   * nothing to check -- the model read the picture, and only the corpus can say whether it
   * read it correctly.
   */
  const fields = invoiceFieldsFrom(reading, content.path === "TEXT" ? content.text : undefined);

  if (reading.classification === "IS_NOT_INVOICE") {
    return settle(scope, documentId, "NOT_AN_INVOICE", reading.classification, reading.reason);
  }

  /*
   * Read, and still nothing to go on.
   *
   * `§6` sets the minimum for automatic reconciliation at vendor, total and date, and a
   * document short of it gives feature G nothing to match on. `manual-invoice-upload.md
   * §11` is the user's side of this -- "We couldn't read the details from this document" --
   * and the document stays stored and manually linkable, which is the whole point.
   *
   * The classification is still recorded. A document we are confident is an invoice but
   * could not read is not the same as one we think is a delivery note, and
   * `domain-model.md §9 Rule 3` requires the two to stay distinguishable.
   */
  if (!hasMinimumFields(fields)) {
    return settle(scope, documentId, "UNREADABLE", reading.classification, NO_DETAILS);
  }

  const invoiceId = await recordInvoice(scope, documentId, fields);

  await scope.update(
    supportingDocuments,
    { state: "EXTRACTED", classification: reading.classification },
    eq(supportingDocuments.id, documentId),
  );

  return { state: "EXTRACTED", invoiceId, reason: reading.reason };
}

/**
 * Write the invoice this document turned out to be, unless it already has one.
 *
 * The invoice is created **unlinked**: `canonical_transaction_id` stays null, and the
 * partial unique index on it means many unlinked invoices coexist happily.
 * `manual-invoice-upload.md §14` puts the invoice's existence at "once the document has
 * been successfully processed", and linking it to a transaction is feature G's decision,
 * made with evidence this function does not have.
 */
async function recordInvoice(
  scope: WorkspaceScope,
  documentId: string,
  fields: InvoiceFields,
): Promise<string> {
  // A retry that died between writing the invoice and marking the document. Leaning on what
  // is already there rather than on having been here before.
  const already = await existingInvoiceFor(scope, documentId);
  if (already) return already;

  const vendorId = fields.vendor ? await resolveVendor(scope, fields.vendor) : null;

  const [invoice] = await scope.insert(invoices, {
    vendorId,
    invoiceNumber: fields.invoiceNumber,
    invoiceDate: fields.invoiceDate,
    totalMinor: fields.totalMinor,
    currency: fields.currency?.code ?? null,
    taxMinor: fields.taxMinor,
    subtotalMinor: fields.subtotalMinor,
  });

  await scope.insert(invoiceDocuments, {
    invoiceId: invoice.id,
    documentId,
    // The document this invoice was read from. A second file for the same invoice --
    // a covering email, a second page -- is added later and is not primary.
    isPrimary: true,
  });

  return invoice.id;
}

/** The invoice already built from this document, if one was. */
async function existingInvoiceFor(
  scope: WorkspaceScope,
  documentId: string,
): Promise<string | null> {
  const rows = await scope.select(invoiceDocuments, eq(invoiceDocuments.documentId, documentId));
  return rows[0]?.invoiceId ?? null;
}

/** Record where the document ended up, and say so. */
async function settle(
  scope: WorkspaceScope,
  documentId: string,
  state: (typeof TERMINAL)[number],
  classification: "IS_INVOICE" | "UNCERTAIN" | "IS_NOT_INVOICE" | null,
  reason: string,
): Promise<UnderstandingOutcome> {
  await scope.update(
    supportingDocuments,
    classification === null ? { state } : { state, classification },
    eq(supportingDocuments.id, documentId),
  );

  return { state, invoiceId: null, reason };
}
