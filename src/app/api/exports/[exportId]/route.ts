/**
 * A generated Excel export, as a download.
 *
 * The id in the URL is a `reconciliation_exports` row id, never a storage key -- the key
 * never leaves the server (ADR 0007). Authorization is the scope, exactly as for documents.
 */

import { requireScope } from "../../../../auth/workspace";
import { getDocumentStore } from "../../../../storage/blob-store";
import { serveExport } from "../../../../storage/serving";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exportId: string }> },
): Promise<Response> {
  const scope = await requireScope();
  const { exportId } = await params;

  return serveExport(scope, getDocumentStore(), exportId);
}
