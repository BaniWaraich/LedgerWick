/**
 * Searching a requirement's mailboxes, and recording what was found.
 *
 * spec: docs/workflows/retrieve-invoices.md §5–§9, §16–§18 · docs/workflows/connect-gmail.md §5,
 * §7, §8 · docs/state-machines.md §2
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * Sequencing and persistence. Every judgment in here belongs to a file that does one thing:
 * `query.ts` says what to ask Gmail, `evidence.ts` says what the headers establish,
 * `select.ts` chooses what to download, and `decide.ts` says what the search came to. This
 * orders them, talks to Gmail through `src/gmail/`, and writes down what happened.
 *
 * ## Metadata only, structurally
 *
 * This file never imports a function that can fetch a message's contents. What it calls in
 * `src/gmail/mail.ts` returns ids and headers; the download half of that module is the fetch
 * step's, and runs only for messages this file has already selected.
 *
 * ## One mailbox cannot speak for another
 *
 * Each connection is searched on its own and gets its own Mailbox Search row. One needing
 * reauthorization is recorded as such and the others carry on (`connect-gmail.md §4`: "one
 * may be healthy while another needs reauthorization"). A transient failure in any of them
 * stops the whole search, because a search that silently skipped a mailbox would report
 * `NOT_FOUND` about a place it never looked. The workflow retries it instead.
 *
 * ## Running it twice
 *
 * Idempotent by what it writes. The Mailbox Search row is keyed on (requirement,
 * connection) and replaced; the Candidate Emails for a mailbox are replaced as a set, the
 * way `recordCandidates` replaces matching's. A retry after any partial write ends with the
 * same rows as a clean run.
 */

import { and, eq, inArray, not } from "drizzle-orm";

import { isUniqueViolation } from "../db/errors";
import {
  canonicalTransactions,
  candidateEmails,
  invoiceRequirements,
  mailboxSearches,
  vendorAliases,
  vendors,
} from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import { vendorLookupKeys } from "../documents/vendors";
import {
  accessTokenFor,
  ConnectionUnavailableError,
  listConnections,
  markNeedsReauth,
  markUsed,
  type ConnectionSummary,
} from "../gmail/connections";
import { GmailTokenDecryptError, GmailTokenKeyError } from "../gmail/crypto";
import { GmailApiError, messageMetadata, searchMessages, type GmailClient } from "../gmail/mail";
import { GoogleOAuthError, type GoogleOAuthClient } from "../gmail/oauth";
import { vendorKeyAppearsIn } from "../matching/evidence";
import { afterSearch, type AfterSearch, type MailboxOutcome } from "./decide";
import { emailEvidenceFor, type EmailEvidence } from "./evidence";
import {
  keywordQuery,
  searchWindow,
  vendorQuery,
  type SearchPass,
  type SearchWindow,
} from "./query";
import { moveRequirement } from "./requirement-state";
import { selectForFetching } from "./select";
import { RESULTS_PER_PASS } from "./thresholds";

export interface SearchDeps {
  readonly oauth: GoogleOAuthClient;
  readonly gmail: GmailClient;
  /** The token key. Tests pass one; the application reads it from the environment. */
  readonly tokenKey?: Buffer;
  readonly now?: () => Date;
}

export type SearchOutcome =
  /** Nothing to do: no such requirement here, or it is not in a state a search starts from. */
  | { readonly kind: "SKIPPED" }
  /** The workspace has no mailbox to search. The requirement stays `IDENTIFIED`. */
  | { readonly kind: "NO_MAILBOX" }
  | {
      readonly kind: "SEARCHED";
      /** What happens next: download, or settle as not found or blocked. */
      readonly next: AfterSearch;
      readonly selected: number;
      /** Every message worth downloading fitted under the cap. */
      readonly exhaustive: boolean;
    };

/**
 * A failure that no retry can fix: our configuration is wrong. The workflow stops retrying
 * and records `FAILED`, and an operator must act (`retrieve-invoices.md §18`).
 */
export function isPermanentFailure(error: unknown): boolean {
  return (
    (error instanceof GoogleOAuthError && error.kind !== "transient") ||
    (error instanceof GmailApiError && error.kind === "config") ||
    error instanceof GmailTokenKeyError ||
    error instanceof GmailTokenDecryptError
  );
}

/** Thrown out of one mailbox's search when the grant turned out to be invalid. */
class MailboxNeedsReauth extends Error {}

/**
 * The names this payment is known by: for the query, and as keys for the evidence.
 *
 * The vendor identification guessed, and every name of any vendor whose alias appears in
 * the transaction's description. Aliases a model inferred are included on purpose:
 * `retrieve-invoices.md §6.1` lets an inferred alias widen a search, "since every candidate
 * is evaluated on its own evidence afterwards". It can never carry a link, because linking
 * reads the document, not this list.
 */
async function namesFor(
  scope: WorkspaceScope,
  vendorGuess: string | null,
  descriptionNormalized: string,
): Promise<{ names: string[]; keys: string[] }> {
  const aliases = await scope.select(vendorAliases);
  const vendorIds = [
    ...new Set(
      aliases
        .filter((alias) => vendorKeyAppearsIn([alias.aliasNormalized], descriptionNormalized))
        .map((alias) => alias.vendorId),
    ),
  ];

  const known =
    vendorIds.length === 0 ? [] : await scope.select(vendors, inArray(vendors.id, vendorIds));

  const names = [
    vendorGuess,
    ...known.flatMap((vendor) => [vendor.name, vendor.legalName]),
    ...aliases.filter((alias) => vendorIds.includes(alias.vendorId)).map((alias) => alias.alias),
  ].filter((name): name is string => typeof name === "string" && name.trim() !== "");

  const seen = new Set<string>();
  const unique = names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { names: unique, keys: vendorLookupKeys(unique) };
}

/** Write this mailbox's search, replacing whatever the last one recorded. */
async function recordSearch(
  scope: WorkspaceScope,
  values: {
    requirementId: string;
    gmailConnectionId: string;
    window: SearchWindow;
    outcome: MailboxOutcome;
    messagesFound: number;
    truncated: boolean;
    at: Date;
  },
): Promise<void> {
  const row = {
    windowStart: values.window.start,
    windowEnd: values.window.end,
    outcome: values.outcome,
    messagesFound: values.messagesFound,
    truncated: values.truncated,
    searchedAt: values.at,
  };
  const identity = and(
    eq(mailboxSearches.requirementId, values.requirementId),
    eq(mailboxSearches.gmailConnectionId, values.gmailConnectionId),
  );

  const [updated] = await scope.update(mailboxSearches, row, identity);
  if (updated) return;

  try {
    await scope.insert(mailboxSearches, {
      ...row,
      requirementId: values.requirementId,
      gmailConnectionId: values.gmailConnectionId,
    });
  } catch (error) {
    // Another attempt inserted between our update and our insert. Land on its row.
    if (!isUniqueViolation(error, "mailbox_searches_identity_idx")) throw error;
    await scope.update(mailboxSearches, row, identity);
  }
}

/**
 * A mailbox searched earlier in this run turned out, while fetching, to need reconnecting.
 *
 * Its search is no longer one the settle step can rely on: it found messages we could not
 * then read. So it is recorded as a mailbox we could not search, which is the truth that
 * matters for what the requirement comes to.
 */
export async function markMailboxNeedsReauth(
  scope: WorkspaceScope,
  requirementId: string,
  gmailConnectionId: string,
): Promise<void> {
  await scope.update(
    mailboxSearches,
    { outcome: "NEEDS_REAUTH" },
    and(
      eq(mailboxSearches.requirementId, requirementId),
      eq(mailboxSearches.gmailConnectionId, gmailConnectionId),
    ),
  );
}

/** What one mailbox's search produced. */
interface MailboxResult {
  readonly outcome: MailboxOutcome;
}

/**
 * Search one mailbox, both passes, and replace its Candidate Emails.
 *
 * Throws for a transient or permanent failure, after recording `FAILED` for this mailbox,
 * so the requirement's review can say which mailbox it was while the workflow retries.
 */
async function searchMailbox(
  scope: WorkspaceScope,
  connection: ConnectionSummary,
  context: {
    requirementId: string;
    window: SearchWindow;
    names: string[];
    keys: string[];
    transactionDate: string;
  },
  deps: SearchDeps,
  at: Date,
): Promise<MailboxResult> {
  const record = (outcome: MailboxOutcome, messagesFound = 0, truncated = false) =>
    recordSearch(scope, {
      requirementId: context.requirementId,
      gmailConnectionId: connection.id,
      window: context.window,
      outcome,
      messagesFound,
      truncated,
      at,
    });

  try {
    const token = await accessTokenFor(scope, connection.id, deps.oauth, deps.tokenKey);

    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        /*
         * A 401 on a token minted moments ago, or a 403 saying the permission is gone: the
         * user revoked access mid-search. That is `invalid_grant` by another route, and it
         * moves the connection the same way (`connect-gmail.md §8`).
         */
        if (error instanceof GmailApiError && error.kind === "reauth") {
          await markNeedsReauth(scope, connection.id);
          throw new MailboxNeedsReauth();
        }
        throw error;
      }
    };

    const passes: { pass: SearchPass; query: string }[] = [];
    const vendor = vendorQuery(context.window, context.names);
    if (vendor !== null) passes.push({ pass: "VENDOR", query: vendor });
    passes.push({ pass: "KEYWORD", query: keywordQuery(context.window) });

    // The first pass to find a message is the one recorded. VENDOR runs first.
    const foundBy = new Map<string, SearchPass>();
    let truncated = false;

    for (const { pass, query } of passes) {
      const result = await call(() => searchMessages(deps.gmail, token, query, RESULTS_PER_PASS));
      truncated ||= result.truncated;
      for (const id of result.messageIds) if (!foundBy.has(id)) foundBy.set(id, pass);
    }

    const rows: Omit<typeof candidateEmails.$inferInsert, "workspaceId">[] = [];

    for (const [messageId, pass] of foundBy) {
      let metadata;
      try {
        metadata = await call(() => messageMetadata(deps.gmail, token, messageId));
      } catch (error) {
        // Deleted between being listed and being read. It is not there to be found.
        if (error instanceof GmailApiError && error.kind === "gone") continue;
        throw error;
      }

      rows.push({
        requirementId: context.requirementId,
        gmailConnectionId: connection.id,
        gmailMessageId: metadata.id,
        rfc822MessageId: metadata.rfc822MessageId,
        fromHeader: metadata.from,
        subject: metadata.subject,
        sentAt: metadata.receivedAt,
        foundBy: pass,
        evidence: emailEvidenceFor(metadata, {
          vendorKeys: context.keys,
          transactionDate: context.transactionDate,
          mailboxAddress: connection.email,
        }),
      });
    }

    await scope.delete(
      candidateEmails,
      and(
        eq(candidateEmails.requirementId, context.requirementId),
        eq(candidateEmails.gmailConnectionId, connection.id),
      ),
    );
    if (rows.length > 0) await scope.insert(candidateEmails, rows);

    await record("COMPLETED", rows.length, truncated);
    await markUsed(scope, connection.id, at);
    return { outcome: "COMPLETED" };
  } catch (error) {
    if (error instanceof MailboxNeedsReauth || error instanceof ConnectionUnavailableError) {
      await record("NEEDS_REAUTH");
      return { outcome: "NEEDS_REAUTH" };
    }
    await record("FAILED");
    throw error;
  }
}

/**
 * Search every mailbox connected to the requirement's workspace, record what was found,
 * choose what to download, and say what comes next.
 *
 * Moves the requirement into `SEARCHING`, and out of it only when there is nothing to
 * download: to `NOT_FOUND`, or to `BLOCKED` when a mailbox could not be searched. When
 * there is something to download, the requirement stays `SEARCHING` for the fetch step.
 */
export async function searchRequirement(
  scope: WorkspaceScope,
  requirementId: string,
  deps: SearchDeps,
): Promise<SearchOutcome> {
  const requirement = await scope.selectOne(
    invoiceRequirements,
    eq(invoiceRequirements.id, requirementId),
  );

  // Another workspace's requirement reads as absent, and no mailbox is touched for it.
  if (requirement === null) return { kind: "SKIPPED" };

  /*
   * No mailbox, no search, no state change.
   *
   * Connecting a mailbox is optional (`connect-gmail.md §3`), so a workspace without one is
   * not blocked -- it is waiting for an upload, which is what `IDENTIFIED` already says.
   * Disconnected connections are the user's choice and are never searched.
   */
  const mailboxes = (await listConnections(scope))
    .filter((connection) => connection.state !== "DISCONNECTED")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (mailboxes.length === 0) return { kind: "NO_MAILBOX" };

  if (!(await moveRequirement(scope, requirementId, "SEARCH_STARTED"))) {
    return { kind: "SKIPPED" };
  }

  const transaction = await scope.selectOne(
    canonicalTransactions,
    eq(canonicalTransactions.id, requirement.canonicalTransactionId),
  );
  // A requirement cascades with its transaction; this cannot be reached in practice.
  if (transaction === null) return { kind: "SKIPPED" };

  const at = deps.now?.() ?? new Date();
  const window = searchWindow(transaction.valueDate);
  const { names, keys } = await namesFor(
    scope,
    requirement.vendorGuess,
    transaction.descriptionNormalized,
  );

  const outcomes: MailboxOutcome[] = [];
  for (const connection of mailboxes) {
    const result = await searchMailbox(
      scope,
      connection,
      { requirementId, window, names, keys, transactionDate: transaction.valueDate },
      deps,
      at,
    );
    outcomes.push(result.outcome);
  }

  /*
   * What a mailbox the user has since disconnected once contributed is no longer part of
   * this requirement's picture. Its rows go; its documents, if any were fetched, stay --
   * `connect-gmail.md §10` keeps retrieved documents after a disconnect.
   */
  const searched = mailboxes.map((connection) => connection.id);
  const elsewhere = and(
    eq(candidateEmails.requirementId, requirementId),
    not(inArray(candidateEmails.gmailConnectionId, searched)),
  );
  await scope.delete(candidateEmails, elsewhere);
  await scope.delete(
    mailboxSearches,
    and(
      eq(mailboxSearches.requirementId, requirementId),
      not(inArray(mailboxSearches.gmailConnectionId, searched)),
    ),
  );

  const candidates = await scope.select(
    candidateEmails,
    eq(candidateEmails.requirementId, requirementId),
  );
  const selection = selectForFetching(
    candidates.map((row) => ({
      id: row.id,
      gmailConnectionId: row.gmailConnectionId,
      gmailMessageId: row.gmailMessageId,
      rfc822MessageId: row.rfc822MessageId,
      evidence: row.evidence as EmailEvidence[],
    })),
  );

  if (selection.selected.size > 0) {
    await scope.update(
      candidateEmails,
      { selected: true },
      and(
        eq(candidateEmails.requirementId, requirementId),
        inArray(candidateEmails.id, [...selection.selected]),
      ),
    );
  }

  const next = afterSearch({ mailboxes: outcomes, selected: selection.selected.size });
  if (next === "NOT_FOUND") await moveRequirement(scope, requirementId, "SETTLED_NOT_FOUND");
  if (next === "BLOCKED") await moveRequirement(scope, requirementId, "SETTLED_BLOCKED");

  return {
    kind: "SEARCHED",
    next,
    selected: selection.selected.size,
    exhaustive: selection.exhaustive,
  };
}
