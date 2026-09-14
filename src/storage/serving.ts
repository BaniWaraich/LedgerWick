/**
 * Serving document bytes to a signed-in user.
 *
 * `docs/definition-of-done.md`: "Documents are served through an authorized route, never
 * a public storage URL." ADR 0007 makes that the only way bytes reach a browser at all,
 * because there is no public URL to leak.
 *
 * The authorization is the `WorkspaceScope` the caller must already hold. Every lookup
 * here goes through `scope.selectOne`, where the workspace filter is not optional, so a
 * row belonging to another workspace is not found rather than found-and-refused.
 *
 * This module takes a scope and a store as arguments instead of reaching for them, so the
 * route stays a thin adapter and the isolation test can attack this function directly.
 */

import { eq } from "drizzle-orm";

import { bankStatements, supportingDocuments } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { DocumentStore } from "./document-store";

/**
 * A missing row and another workspace's row are the same answer.
 *
 * 404, never 403. A 403 tells the caller the id exists, which is exactly the fact the
 * isolation boundary is there to withhold — the same reasoning `WorkspaceAccessError`
 * already applies to workspace ids.
 */
function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * Both ids are uuid columns, and Postgres rejects a malformed value with an error rather
 * than an empty result. Checking the shape first turns a crafted URL into the same 404
 * every other unknown id gets, instead of a 500 that confirms the parameter reached the
 * database.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stream one stored object back.
 *
 * The response carries bytes and the row's own MIME type. It carries no `storage_ref`,
 * no blob URL, and no signed URL: a signed URL is a bearer token that outlives the
 * session check that produced it, which is why `presignUrl` exists in the SDK and is not
 * used here.
 *
 * `filename` comes from the database row rather than from the object, so what the user
 * saves is the name they uploaded, not the suffixed storage key.
 */
async function streamObject(
  store: DocumentStore,
  storageRef: string,
  mimeType: string,
  filename: string,
): Promise<Response> {
  const object = await store.get(storageRef);

  // The row exists but its bytes do not. That is a broken reference, not a missing
  // document, but the user can do nothing with the distinction and an attacker could.
  if (!object) return notFound();

  return new Response(object.stream, {
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(object.size),
      // Inline: these are previewed in the app (invoice-match-review §5). The quoted
      // filename is sanitized because it is user-supplied and lands in a header.
      "Content-Disposition": `inline; filename="${filename.replace(/["\r\n]/g, "")}"`,
      // A document is private to one workspace; no shared cache may hold it.
      "Cache-Control": "private, no-store",
    },
  });
}

/** The original file a bank statement was parsed from. */
export async function serveStatementFile(
  scope: WorkspaceScope,
  store: DocumentStore,
  statementId: string,
): Promise<Response> {
  if (!UUID.test(statementId)) return notFound();

  const statement = await scope.selectOne(bankStatements, eq(bankStatements.id, statementId));
  if (!statement) return notFound();

  return streamObject(store, statement.storageRef, statement.mimeType, statement.filename);
}

/** A supporting document — uploaded by the user, or retrieved from a mailbox. */
export async function serveSupportingDocument(
  scope: WorkspaceScope,
  store: DocumentStore,
  documentId: string,
): Promise<Response> {
  if (!UUID.test(documentId)) return notFound();

  const document = await scope.selectOne(
    supportingDocuments,
    eq(supportingDocuments.id, documentId),
  );
  if (!document) return notFound();

  return streamObject(store, document.storageRef, document.mimeType, document.filename);
}
