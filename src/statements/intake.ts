/**
 * Taking an upload batch in: bytes to storage, one row per file.
 *
 * This is Steps 1–2 of `docs/workflows/upload-statement.md`, and the boundary at which
 * `docs/architecture.md §13` switches from synchronous to background: the request stores
 * the file, persists the initial state, sends an event, and returns. Nothing is inferred
 * from the document here — that is `identify.ts`, running in a workflow.
 *
 * Written as a function over a scope, a store and a publisher rather than reaching for any
 * of them, for the same reason `src/storage/serving.ts` is: the route stays a thin adapter
 * and the isolation tests can attack this directly.
 */

import { randomUUID } from "node:crypto";

import { bankStatements } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { DocumentStore } from "../storage/document-store";
import { documentKey } from "../storage/keys";

/**
 * What this feature can parse, and therefore what it accepts.
 *
 * `upload-statement.md §3` also lists Excel, but `docs/phases/phase-1.md` scopes Phase 1
 * to CSV, text PDF and scanned PDF throughout — §7 C/D and the phase boundary never
 * mention a spreadsheet path. Excel is rejected here rather than silently half-supported;
 * the gap between the two documents is real and is recorded in the phase, not resolved by
 * quietly widening this list.
 */
const ACCEPTED_MIME_TYPES = new Set(["application/pdf", "text/csv"]);

/**
 * Extensions we will accept in place of the browser's guess.
 *
 * Browsers disagree about CSV — Windows reports `application/vnd.ms-excel` for a .csv
 * that Excel has ever opened, and some report nothing at all. Trusting only the MIME type
 * would reject ordinary files for a reason the user cannot act on.
 */
const ACCEPTED_EXTENSIONS = /\.(pdf|csv)$/i;

/** User-facing reasons a file was turned away. `§9` asks for these, not error codes. */
const UNSUPPORTED_FORMAT =
  "We can only read PDF and CSV statements. Export this one as a PDF or CSV and try again.";
const COULD_NOT_STORE = "We couldn't save this file. Please try uploading it again.";

function isAcceptable(file: File): boolean {
  return ACCEPTED_MIME_TYPES.has(file.type) || ACCEPTED_EXTENSIONS.test(file.name);
}

/**
 * One file's fate.
 *
 * `statementId` is null only when storing the bytes failed, which is the one case where
 * no row can exist: `storage_ref` is the row's link to the original, and a row without
 * one would claim to hold a document the system cannot produce.
 */
export interface IntakeResult {
  statementId: string | null;
  filename: string;
  accepted: boolean;
  /** Present when the file was turned away, in words the user can act on (`§9`). */
  reason?: string;
}

/** Sends the event that starts identification. Injected so intake stays testable. */
export type PublishUploaded = (statementId: string) => Promise<void>;

/**
 * Store one file and record it, whether or not we can read it.
 *
 * An unreadable file is still stored. `architecture.md §2.1` makes the original the
 * source of truth and the definition of done forbids automated deletion — and a FAILED
 * row the user can see after a refresh is worth more than a rejection that exists only in
 * the response to a request they have already navigated away from.
 *
 * The id is minted here rather than by the database because the storage key is built from
 * it (`documentKey`, feature B) and the row cannot be inserted without the key. Nothing is
 * guessed from the returned reference either: Blob appends a random suffix, so what is
 * persisted is the key the store reports, never the key we asked for.
 */
async function intakeFile(
  scope: WorkspaceScope,
  store: DocumentStore,
  uploadBatchId: string,
  file: File,
): Promise<IntakeResult> {
  const id = randomUUID();
  const key = documentKey(scope.workspaceId, "statements", id, file.name);
  const contentType = file.type === "" ? "application/octet-stream" : file.type;

  const stored = await store.put(key, Buffer.from(await file.arrayBuffer()), contentType);

  const accepted = isAcceptable(file);
  const [statement] = await scope.insert(bankStatements, {
    id,
    uploadBatchId,
    filename: file.name,
    mimeType: contentType,
    storageRef: stored.key,
    // UPLOADING is honest for the moment between this row existing and the workflow
    // picking it up; identification moves it to IDENTIFYING.
    state: accepted ? "UPLOADING" : "FAILED",
    failureReason: accepted ? null : UNSUPPORTED_FORMAT,
  });

  return {
    statementId: statement.id,
    filename: file.name,
    accepted,
    ...(accepted ? {} : { reason: UNSUPPORTED_FORMAT }),
  };
}

/**
 * Take in one upload batch.
 *
 * `§11`: the files are one batch for display and independent for processing. That is why
 * each file is stored and recorded on its own and why one failure cannot end the loop —
 * a file that throws becomes a FAILED row like any other, and its neighbours still land.
 */
export async function intakeBatch(
  scope: WorkspaceScope,
  store: DocumentStore,
  files: File[],
  publish: PublishUploaded,
): Promise<{ uploadBatchId: string; results: IntakeResult[] }> {
  const uploadBatchId = randomUUID();
  const results: IntakeResult[] = [];

  for (const file of files) {
    let result: IntakeResult;

    try {
      result = await intakeFile(scope, store, uploadBatchId, file);
    } catch {
      // Storage or the database refused this one file. The loop continues, because §3 is
      // explicit that one file's failure must not stop its neighbours. The error itself is
      // not surfaced: it says nothing the user can act on, and it may name infrastructure.
      result = { statementId: null, filename: file.name, accepted: false, reason: COULD_NOT_STORE };
    }

    results.push(result);

    // Sent per file, so identification of one statement cannot be delayed or skipped by
    // another. A send that fails leaves the row in UPLOADING rather than losing the file.
    if (result.accepted && result.statementId) await publish(result.statementId);
  }

  return { uploadBatchId, results };
}
