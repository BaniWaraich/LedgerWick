/**
 * Downloading the selected messages' PDFs, and storing them as Supporting Documents.
 *
 * spec: docs/workflows/retrieve-invoices.md §11, §14 · docs/workflows/connect-gmail.md §5
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * The one place retrieval reads a message's contents, and only for messages `search.ts`
 * already selected from their headers. Only attachments leave Gmail: `attachmentsOf`
 * returns a message's attachment list and discards its body inside `src/gmail/mail.ts`.
 *
 * Stored through `storeSupportingDocument`, the same front door an upload uses. Nothing is
 * published on `document/stored`: the assessor understands these documents itself, through
 * the same `understandDocument`, so that no retrieved document can be matched and linked
 * on its own before the others found for the same payment have been judged (`0016`).
 *
 * ## Running it twice
 *
 * - A message already fetched in this run carries a fetch outcome and is not downloaded
 *   again.
 * - A message fetched by an earlier run, from the same mailbox, is recognised by the
 *   provenance on its documents and reuses them. It costs no download and no second model
 *   call, since those documents are already understood.
 * - The same file reached any other way has the same hash, and intake returns the document
 *   already stored.
 */

import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { isUniqueViolation } from "../db/errors";
import {
  candidateEmailDocuments,
  candidateEmails,
  mailboxSearches,
  supportingDocuments,
} from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { storeSupportingDocument } from "../documents/intake";
import { accessTokenFor, ConnectionUnavailableError, markNeedsReauth } from "../gmail/connections";
import {
  attachmentsOf,
  downloadAttachment,
  GmailApiError,
  type AttachmentRef,
} from "../gmail/mail";
import type { DocumentStore } from "../storage/document-store";
import { afterSearch } from "./decide";
import { moveRequirement } from "./requirement-state";
import { markMailboxNeedsReauth, type SearchDeps } from "./search";
import { MAX_ATTACHMENT_BYTES } from "./thresholds";

export interface FetchDeps extends SearchDeps {
  readonly store: DocumentStore;
}

type CandidateRow = typeof candidateEmails.$inferSelect;

/** Provenance kept on a retrieved document: `retrieve-invoices.md §11`'s trace, less the requirement. */
export interface GmailProvenance {
  readonly gmailConnectionId: string;
  readonly gmailMessageId: string;
  readonly rfc822MessageId: string | null;
  readonly partId: string;
  readonly filename: string;
}

/** V1 retrieves PDFs (`retrieve-invoices.md §11`). A PDF is often sent as octet-stream. */
function looksLikePdf(ref: AttachmentRef): boolean {
  return ref.mimeType === "application/pdf" || /\.pdf$/i.test(ref.filename);
}

/** The bytes are a PDF, whatever the email claimed. */
function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

async function link(scope: WorkspaceScope, candidateEmailId: string, documentId: string) {
  try {
    await scope.insert(candidateEmailDocuments, { candidateEmailId, documentId });
  } catch (error) {
    // Already linked by an earlier attempt. That is the answer, not a failure.
    if (!isUniqueViolation(error, "candidate_email_documents_pk")) throw error;
  }
}

/**
 * Documents already fetched from this message, if any.
 *
 * Two ways a message can have been fetched before. This mailbox fetched it in an earlier
 * run, which the documents' provenance records. Or it is the same mail as another
 * candidate for this requirement, reached through another mailbox, which the RFC 822
 * Message-ID says, and which this run has already fetched.
 */
async function alreadyFetched(scope: WorkspaceScope, row: CandidateRow): Promise<string[]> {
  const earlier = await scope.select(
    supportingDocuments,
    and(
      eq(supportingDocuments.source, "GMAIL"),
      sql`${supportingDocuments.sourceMetadata}->>'gmailConnectionId' = ${row.gmailConnectionId}`,
      sql`${supportingDocuments.sourceMetadata}->>'gmailMessageId' = ${row.gmailMessageId}`,
    ),
  );
  if (earlier.length > 0) return earlier.map((document) => document.id);

  if (row.rfc822MessageId === null) return [];

  const siblings = await scope.select(
    candidateEmails,
    and(
      eq(candidateEmails.requirementId, row.requirementId),
      eq(candidateEmails.rfc822MessageId, row.rfc822MessageId),
      eq(candidateEmails.fetchOutcome, "FETCHED"),
    ),
  );
  if (siblings.length === 0) return [];

  const joins = await scope.select(
    candidateEmailDocuments,
    inArray(
      candidateEmailDocuments.candidateEmailId,
      siblings.map((sibling) => sibling.id),
    ),
  );
  return [...new Set(joins.map((join) => join.documentId))];
}

/** Download one message's PDFs and store each. Returns the documents it produced. */
async function fetchMessage(
  scope: WorkspaceScope,
  row: CandidateRow,
  token: string,
  deps: FetchDeps,
): Promise<string[]> {
  const refs = (await attachmentsOf(deps.gmail, token, row.gmailMessageId)).filter(
    (ref) => looksLikePdf(ref) && ref.size <= MAX_ATTACHMENT_BYTES,
  );

  const documents: string[] = [];

  for (const ref of refs) {
    const bytes = await downloadAttachment(deps.gmail, token, row.gmailMessageId, ref.attachmentId);
    // Named .pdf and is not one. Not something understanding could read as a PDF either.
    if (!isPdf(bytes) || bytes.length > MAX_ATTACHMENT_BYTES) continue;

    const provenance: GmailProvenance = {
      gmailConnectionId: row.gmailConnectionId,
      gmailMessageId: row.gmailMessageId,
      rfc822MessageId: row.rfc822MessageId,
      partId: ref.partId,
      filename: ref.filename,
    };

    const { documentId } = await storeSupportingDocument(
      scope,
      deps.store,
      { bytes, filename: ref.filename, contentType: "application/pdf" },
      {
        source: "GMAIL",
        sourceMetadata: provenance,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
      },
      // Not published: the assessor understands retrieved documents itself (`0016`).
      async () => {},
    );

    if (!documents.includes(documentId)) documents.push(documentId);
  }

  return documents;
}

/**
 * Fetch every selected message for one requirement that has not been fetched yet.
 *
 * Returns the documents fetched for this requirement, across every mailbox, including those
 * an earlier attempt of this run already stored.
 *
 * A mailbox whose grant turns out to be invalid while fetching is marked, as searching
 * marks one, and its remaining messages are left; the other mailboxes carry on. A transient
 * failure throws, and the workflow retries this step. What was already fetched stays
 * fetched.
 */
export async function fetchSelected(
  scope: WorkspaceScope,
  requirementId: string,
  deps: FetchDeps,
): Promise<string[]> {
  const rows = (
    await scope.select(
      candidateEmails,
      and(eq(candidateEmails.requirementId, requirementId), eq(candidateEmails.selected, true)),
    )
  ).sort((a, b) =>
    a.gmailConnectionId === b.gmailConnectionId
      ? a.gmailMessageId.localeCompare(b.gmailMessageId)
      : a.gmailConnectionId.localeCompare(b.gmailConnectionId),
  );

  const tokens = new Map<string, string>();
  const unreachable = new Set<string>();

  const setOutcome = (row: CandidateRow, outcome: CandidateRow["fetchOutcome"]) =>
    scope.update(candidateEmails, { fetchOutcome: outcome }, eq(candidateEmails.id, row.id));

  const giveUpOn = async (connectionId: string) => {
    unreachable.add(connectionId);
    await markMailboxNeedsReauth(scope, requirementId, connectionId);
  };

  for (const row of rows) {
    if (row.fetchOutcome !== null || unreachable.has(row.gmailConnectionId)) continue;

    const reused = await alreadyFetched(scope, row);
    if (reused.length > 0) {
      for (const documentId of reused) await link(scope, row.id, documentId);
      await setOutcome(row, "FETCHED");
      continue;
    }

    try {
      let token = tokens.get(row.gmailConnectionId);
      if (token === undefined) {
        token = await accessTokenFor(scope, row.gmailConnectionId, deps.oauth, deps.tokenKey);
        tokens.set(row.gmailConnectionId, token);
      }

      const documents = await fetchMessage(scope, row, token, deps);
      for (const documentId of documents) await link(scope, row.id, documentId);
      await setOutcome(row, documents.length > 0 ? "FETCHED" : "NO_ATTACHMENT");
    } catch (error) {
      if (error instanceof ConnectionUnavailableError) {
        await giveUpOn(row.gmailConnectionId);
        continue;
      }
      if (error instanceof GmailApiError && error.kind === "reauth") {
        await markNeedsReauth(scope, row.gmailConnectionId);
        await giveUpOn(row.gmailConnectionId);
        continue;
      }
      // Deleted between being found and being fetched.
      if (error instanceof GmailApiError && error.kind === "gone") {
        await setOutcome(row, "MESSAGE_GONE");
        continue;
      }
      throw error;
    }
  }

  return documentsFor(scope, requirementId);
}

/** Every document fetched for this requirement, through any of its Candidate Emails. */
export async function documentsFor(
  scope: WorkspaceScope,
  requirementId: string,
): Promise<string[]> {
  const rows = await scope.select(
    candidateEmails,
    eq(candidateEmails.requirementId, requirementId),
  );
  if (rows.length === 0) return [];

  const joins = await scope.select(
    candidateEmailDocuments,
    inArray(
      candidateEmailDocuments.candidateEmailId,
      rows.map((row) => row.id),
    ),
  );

  return [...new Set(joins.map((join) => join.documentId))].sort();
}

export type AfterFetch =
  /** Documents await assessment. The requirement is `EVALUATING`. */
  | { readonly next: "ASSESS"; readonly documents: string[] }
  /** Nothing usable came down; settled as `NOT_FOUND` or `BLOCKED`. */
  | { readonly next: "NOT_FOUND" | "BLOCKED" }
  /** The requirement stopped waiting on this search -- resolved meanwhile, most likely. */
  | { readonly next: "NONE" };

/**
 * Fetch, and move the requirement on to whatever the fetch makes of it.
 *
 * Selected messages that yielded no PDF -- an invoice embedded in an HTML body, a `.docx`,
 * a message deleted since -- leave nothing to assess. Then the requirement settles as a
 * search that found nothing would: `NOT_FOUND`, or `BLOCKED` when a mailbox went unsearched.
 */
export async function fetchForRequirement(
  scope: WorkspaceScope,
  requirementId: string,
  deps: FetchDeps,
): Promise<AfterFetch> {
  const documents = await fetchSelected(scope, requirementId, deps);

  if (documents.length > 0) {
    return (await moveRequirement(scope, requirementId, "DOCUMENTS_FETCHED"))
      ? { next: "ASSESS", documents }
      : { next: "NONE" };
  }

  const searches = await scope.select(
    mailboxSearches,
    eq(mailboxSearches.requirementId, requirementId),
  );
  const next = afterSearch({ mailboxes: searches.map((s) => s.outcome), selected: 0 });
  const event = next === "BLOCKED" ? "SETTLED_BLOCKED" : "SETTLED_NOT_FOUND";

  return (await moveRequirement(scope, requirementId, event))
    ? { next: next === "BLOCKED" ? "BLOCKED" : "NOT_FOUND" }
    : { next: "NONE" };
}
