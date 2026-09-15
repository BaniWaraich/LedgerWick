/**
 * Receiving an upload batch.
 *
 * The bytes come through the server rather than straight from the browser to Blob. A
 * client-direct upload would need a write credential in the page, and ADR 0007 keeps the
 * store behind the application — the browser never learns a storage key, let alone a
 * token that could write one.
 *
 * Authorization is `requireScope`: the workspace comes from the session, so nothing the
 * client sends chooses where its files land.
 */

import { requireScope } from "../../../auth/workspace";
import { inngest, statementUploaded } from "../../../inngest/client";
import { intakeBatch } from "../../../statements/intake";
import { getDocumentStore } from "../../../storage/blob-store";

/**
 * The largest file we will read into memory.
 *
 * A transport guard, not a domain rule: a bank statement of this size does not exist, and
 * without a cap one request can exhaust the function's memory. Rejected here, before the
 * body is read, so nothing is stored and no row is created.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const scope = await requireScope();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "That upload could not be read." }, { status: 400 });
  }

  const files = form.getAll("files").filter((value): value is File => value instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "Choose at least one file to upload." }, { status: 400 });
  }

  const tooLarge = files.find((file) => file.size > MAX_FILE_BYTES);
  if (tooLarge) {
    return Response.json(
      { error: `${tooLarge.name} is larger than 25MB. Please upload a smaller file.` },
      { status: 413 },
    );
  }

  const { uploadBatchId, results } = await intakeBatch(
    scope,
    getDocumentStore(),
    files,
    async (statementId) => {
      await inngest.send(
        statementUploaded.create({
          statementId,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
        }),
      );
    },
  );

  return Response.json({ uploadBatchId, results }, { status: 202 });
}
