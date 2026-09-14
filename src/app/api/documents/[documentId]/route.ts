/**
 * A supporting document's bytes — an uploaded invoice, or one retrieved from a mailbox.
 *
 * Previews in match review stream through here (`docs/workflows/invoice-match-review.md
 * §5`), which is the whole reason the route exists: the frontend is given a document id,
 * never a storage reference.
 */

import { requireScope } from "../../../../auth/workspace";
import { getDocumentStore } from "../../../../storage/blob-store";
import { serveSupportingDocument } from "../../../../storage/serving";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const scope = await requireScope();
  const { documentId } = await params;

  return serveSupportingDocument(scope, getDocumentStore(), documentId);
}
