/**
 * Taking one supporting document in: bytes to storage, one row, one event.
 *
 * spec: docs/workflows/manual-invoice-upload.md §3 and §14
 * spec: docs/workflows/retrieve-invoices.md §11.1 and §14
 *
 * The shared front door. `§11.1` requires that "the two entry paths converge here, and
 * neither skips it", and this is where they converge: feature G calls it with a file the
 * user chose, feature K calls it with an attachment it fetched, and neither has a way to
 * put a document into the system without understanding following.
 *
 * Deliberately entry-agnostic beyond the one thing that genuinely differs — `source`, which
 * says whether this came from Gmail or an upload, and `sourceMetadata`, which `§11` requires
 * carry a retrieved document's provenance back to its account, message and attachment. This
 * module never reads either. They are recorded for the features that will.
 *
 * The same shape as `src/statements/intake.ts`, and for the same reason
 * `architecture.md §13` gives: store the file, persist the initial state, send the event,
 * return. Nothing is inferred from the document here.
 */

import { eq } from "drizzle-orm";

import { canonicalTransactions, supportingDocuments } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { DocumentStore } from "../storage/document-store";
import { documentKey } from "../storage/keys";

/** Sends the event that starts understanding. Injected so intake stays testable. */
export type PublishStored = (documentId: string) => Promise<void>;

/** Where a document came from, and what that entry path knows about it. */
export interface DocumentOrigin {
  readonly source: "GMAIL" | "MANUAL_UPLOAD";
  /**
   * Provenance, for a retrieved document.
   *
   * `retrieve-invoices.md §11` requires a stored attachment to be traceable to the Gmail
   * account, the message and the attachment it came from. Opaque here on purpose: feature K
   * owns its shape, and this module would only be guessing at it.
   */
  readonly sourceMetadata?: unknown;
  /**
   * The payment this document is evidence of, where the user already said.
   *
   * Set when an upload starts from match review (`invoice-match-review.md §6`): the
   * transaction is known before the document is read, and feature G skips matching
   * entirely rather than computing a shortlist to agree with them.
   *
   * Bound here rather than after understanding because it is true from the moment the
   * file arrives, and because a document that turns out not to be an invoice is then
   * already attached to its payment -- `domain-model.md §5.1`'s second branch, with no
   * second code path to keep in step.
   */
  readonly canonicalTransactionId?: string;
}

/** What storing one document produced. */
export interface StoredDocument {
  readonly documentId: string;
  /** False when the bytes are safe but nothing was told to process them. */
  readonly started: boolean;
}

/**
 * Store a supporting document and start understanding it.
 *
 * The row is written before the bytes so that the key can be built from its id — the same
 * ordering `src/statements/intake.ts` uses, and the reason `documentKey` takes a unique
 * segment rather than generating one. `storage_ref` is then updated to whatever the store
 * actually returned, because Vercel Blob appends a random suffix and the requested key is a
 * request rather than a promise (ADR 0007).
 *
 * A failure to publish is reported rather than thrown. The bytes are stored and the row
 * exists; what is missing is the queue, and losing the document over that would be worse
 * than a caller being told to try again. Nothing here ever deletes.
 */
export async function storeSupportingDocument(
  scope: WorkspaceScope,
  store: DocumentStore,
  file: { bytes: Uint8Array; filename: string; contentType: string },
  origin: DocumentOrigin,
  publish: PublishStored,
): Promise<StoredDocument> {
  /*
   * A transaction id from the client is a claim, not a fact.
   *
   * `docs/definition-of-done.md`: no workspace identifier comes from the client without
   * being checked against the session. The same holds for anything reached through one --
   * the scope filters the lookup, so a transaction belonging to another workspace reads
   * as absent and the document is stored unbound rather than bound to a stranger's
   * payment. Silently unbound rather than refused, for the reason the rest of this module
   * gives: nothing is worth losing the document over.
   */
  const bound =
    origin.canonicalTransactionId === undefined
      ? null
      : ((
          await scope.selectOne(
            canonicalTransactions,
            eq(canonicalTransactions.id, origin.canonicalTransactionId),
          )
        )?.id ?? null);

  const [document] = await scope.insert(supportingDocuments, {
    canonicalTransactionId: bound,
    // Replaced below with the key the store returned. Never left as this value: a row whose
    // storage_ref does not resolve claims to hold a document the system cannot produce.
    storageRef: "",
    filename: file.filename,
    mimeType: file.contentType,
    source: origin.source,
    sourceMetadata: origin.sourceMetadata ?? null,
  });

  const stored = await store.put(
    documentKey(scope.workspaceId, "documents", document.id, file.filename),
    Buffer.from(file.bytes),
    file.contentType,
  );

  await scope.update(supportingDocuments, { storageRef: stored.key }, eqDocument(document.id));

  try {
    await publish(document.id);
  } catch {
    return { documentId: document.id, started: false };
  }

  return { documentId: document.id, started: true };
}

function eqDocument(documentId: string) {
  return eq(supportingDocuments.id, documentId);
}
