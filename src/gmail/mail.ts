/**
 * Reading a mailbox: the only file that talks to the Gmail API.
 *
 * spec: docs/workflows/connect-gmail.md §5, §8 · docs/workflows/retrieve-invoices.md §9, §18
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * `gmail.readonly` lets the token read everything, so the narrowing happens here or it does
 * not happen at all (`connect-gmail.md §5`: "a self-imposed discipline ... worth nothing
 * unless it is enforced here"). Two rules shape every function below:
 *
 * - **Search is metadata only.** Finding and evaluating candidates uses `messages.list`,
 *   which returns ids, and `format=metadata`, which returns headers. Nothing on the search
 *   path can ask for more. `tests/gmail/mail.test.ts` asserts it against every request made.
 * - **Nothing resembling a body leaves this file.** `format=metadata` also returns a
 *   `snippet`, which is a fragment of the body. Each function returns a value built field by
 *   field, so a snippet has no way out. A spread here is how one would escape.
 *
 * Failures leave as a `GmailApiError` with a kind and nothing else. Google's response body
 * is never thrown, logged or returned -- the rule `oauth.ts` follows for the same reason.
 */

import "server-only";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The headers retrieval reads. Asked for by name, so Google returns no others. */
const METADATA_HEADERS = ["From", "To", "Subject", "Date", "Message-ID"] as const;

/** The network. Injected so tests script Gmail rather than call it. */
export type GmailClient = { fetch: typeof fetch };

export function gmailClient(): GmailClient {
  return { fetch: globalThis.fetch };
}

/**
 * Why a Gmail call did not produce what was asked.
 *
 * - `reauth`: the grant no longer lets us read this mailbox. The user must reconnect
 *   (`connect-gmail.md §8`). A 401 with a token minted seconds ago, or a 403 that says
 *   the permission is missing.
 * - `transient`: rate limited, Google unavailable, or the network failed. Retry later, and
 *   never mark a connection broken over it.
 * - `gone`: the message no longer exists. It was deleted between being found and being read.
 * - `config`: anything else Google refused. Our request is wrong; an operator must act.
 */
export type GmailApiErrorKind = "reauth" | "transient" | "gone" | "config";

export class GmailApiError extends Error {
  constructor(readonly kind: GmailApiErrorKind) {
    // The kind is the whole message. Nothing Google sent back is repeated here.
    super(`Gmail API failed: ${kind}`);
    this.name = "GmailApiError";
  }
}

/** The reasons Google gives on a 403 that mean "slow down" rather than "not allowed". */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

async function failureOf(response: Response): Promise<GmailApiError> {
  if (response.status === 401) return new GmailApiError("reauth");
  if (response.status === 404) return new GmailApiError("gone");
  if (response.status === 429 || response.status >= 500) return new GmailApiError("transient");

  if (response.status === 403) {
    let reasons: unknown[] = [];
    try {
      const body = (await response.json()) as { error?: { errors?: { reason?: unknown }[] } };
      reasons = (body.error?.errors ?? []).map((e) => e.reason);
    } catch {
      // Unreadable 403: we cannot tell which kind, and asking the user to reconnect over a
      // body we could not parse would mark a connection broken on no evidence.
      return new GmailApiError("transient");
    }
    return reasons.some((r) => typeof r === "string" && RATE_LIMIT_REASONS.has(r))
      ? new GmailApiError("transient")
      : new GmailApiError("reauth");
  }

  return new GmailApiError("config");
}

async function get(client: GmailClient, token: string, url: URL): Promise<unknown> {
  let response: Response;
  try {
    response = await client.fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new GmailApiError("transient");
  }

  if (!response.ok) throw await failureOf(response);

  try {
    return await response.json();
  } catch {
    throw new GmailApiError("transient");
  }
}

/** What one search returned: message ids, and whether there were more than we took. */
export interface SearchResult {
  readonly messageIds: string[];
  /** Google had more results than `max`. What was found is not everything that matched. */
  readonly truncated: boolean;
}

/**
 * Message ids matching a Gmail search query. Ids only: `messages.list` returns nothing else.
 *
 * One page, capped at `max`. A search that needs a second page is too broad to be a search
 * for one transaction's document, and saying so (`truncated`) is more useful than reading on.
 */
export async function searchMessages(
  client: GmailClient,
  token: string,
  query: string,
  max: number,
): Promise<SearchResult> {
  const url = new URL(`${API}/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", String(max));

  const body = (await get(client, token, url)) as {
    messages?: { id?: unknown }[];
    nextPageToken?: unknown;
  };

  const messageIds = (body.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id !== "");

  return { messageIds, truncated: typeof body.nextPageToken === "string" };
}

/** A message's headers: what search and evaluation are allowed to see. No body, no snippet. */
export interface MessageMetadata {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  /** The RFC 822 Message-ID header, when the sender set one. */
  readonly rfc822MessageId: string | null;
  /** When Gmail received it. `internalDate`, which unlike `Date:` the sender cannot set. */
  readonly receivedAt: Date;
}

/**
 * One message's headers, via `format=metadata`.
 *
 * Built field by field from the headers asked for. `snippet`, `labelIds` and anything
 * else Google includes are never read, so they cannot be returned.
 */
export async function messageMetadata(
  client: GmailClient,
  token: string,
  messageId: string,
): Promise<MessageMetadata> {
  const url = new URL(`${API}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of METADATA_HEADERS) url.searchParams.append("metadataHeaders", header);

  const body = (await get(client, token, url)) as {
    id?: unknown;
    internalDate?: unknown;
    payload?: { headers?: { name?: unknown; value?: unknown }[] };
  };

  const header = (name: string): string => {
    const found = (body.payload?.headers ?? []).find(
      (h) => typeof h.name === "string" && h.name.toLowerCase() === name.toLowerCase(),
    );
    return typeof found?.value === "string" ? found.value : "";
  };

  const received = Number(body.internalDate);

  return {
    id: typeof body.id === "string" ? body.id : messageId,
    from: header("From"),
    to: header("To"),
    subject: header("Subject"),
    rfc822MessageId: header("Message-ID") || null,
    receivedAt: new Date(Number.isFinite(received) ? received : 0),
  };
}
