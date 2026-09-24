/**
 * Receiving an uploaded invoice.
 *
 * The counterpart to `api/statements/route.ts`, and the same shape for the same reasons:
 * the bytes come through the server because ADR 0007 keeps the store behind the
 * application, and the workspace comes from the session so nothing the client sends
 * chooses where its file lands.
 *
 * One file per request rather than a batch. A statement upload is a batch because a
 * business exports several months at once; an invoice arrives because the user is looking
 * at one payment (`manual-invoice-upload.md §2`), and a batch endpoint here would be an
 * interface nothing asks for.
 */

import { requireScope } from "../../../auth/workspace";
import { storeSupportingDocument } from "../../../documents/intake";
import { documentStored, inngest } from "../../../inngest/client";
import { getDocumentStore } from "../../../storage/blob-store";

/**
 * The largest file we will read into memory.
 *
 * A transport guard, not a domain rule, as the statements route puts it. Photographs of
 * physical invoices are the big case here and a phone photo is a few megabytes.
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

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "Choose a file to upload." }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return Response.json(
      { error: `${file.name} is larger than 25MB. Please upload a smaller file.` },
      { status: 413 },
    );
  }

  /*
   * The payment, where the user already chose one.
   *
   * Passed through as a claim and checked against the workspace in `intake.ts`, not here:
   * that module owns the write and is where the scope can settle it. A value that is not
   * this workspace's transaction stores the document unbound rather than refusing it.
   */
  const transactionId = form.get("transactionId");

  const { documentId, started } = await storeSupportingDocument(
    scope,
    getDocumentStore(),
    {
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      contentType: file.type || "application/octet-stream",
    },
    {
      source: "MANUAL_UPLOAD",
      canonicalTransactionId:
        typeof transactionId === "string" && transactionId !== "" ? transactionId : undefined,
    },
    async (id) => {
      await inngest.send(
        documentStored.create({
          documentId: id,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
        }),
      );
    },
  );

  // 202: the bytes are safe and the work is queued. `started: false` means the row exists
  // and nothing is processing it -- the screen says so rather than pretending.
  return Response.json({ documentId, started }, { status: 202 });
}
