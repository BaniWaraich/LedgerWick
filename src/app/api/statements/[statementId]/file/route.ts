/**
 * The original file a bank statement was uploaded as.
 *
 * The id in the URL is a `bank_statements` row id, never a storage key — the key never
 * leaves the server (ADR 0007). Authorization is the scope: `requireScope` derives the
 * workspace from the session, so nothing a client sends chooses which workspace is read.
 */

import { requireScope } from "../../../../../auth/workspace";
import { getDocumentStore } from "../../../../../storage/blob-store";
import { serveStatementFile } from "../../../../../storage/serving";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ statementId: string }> },
): Promise<Response> {
  const scope = await requireScope();
  const { statementId } = await params;

  return serveStatementFile(scope, getDocumentStore(), statementId);
}
