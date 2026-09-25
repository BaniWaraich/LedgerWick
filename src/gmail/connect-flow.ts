/**
 * Connecting a mailbox, from the click to the recorded connection.
 *
 * spec: docs/workflows/connect-gmail.md §3, §5, §9
 *
 * The route handlers in `src/app/api/gmail` are thin wrappers over these two functions.
 * Everything that decides anything is here, where it can be run against a real database
 * with Google scripted, instead of in a handler that needs a live session to reach.
 *
 * The workspace a connection lands in is never taken from the request. `startConnect` is
 * handed a scope the route already opened from the session. `completeConnect` reads the
 * workspace the attempt was *for* out of its own cookie and passes it to `openScope` —
 * `requireScope` in production, which re-checks ownership through `openWorkspace` — so a
 * forged or stale cookie can name a workspace but never get into one.
 */

import "server-only";

import type { WorkspaceScope } from "../db/workspace-scope";
import { recordGrant, type ConnectionSummary } from "./connections";
import {
  beginConnect,
  callbackUri,
  checkCallback,
  decodePending,
  encodePending,
  exchangeCode,
  GoogleOAuthError,
  type GoogleOAuthClient,
  type GoogleOAuthErrorKind,
} from "./oauth";

/** The cookie that carries one attempt across the round trip to Google. */
export const PENDING_COOKIE = "lw_gmail_connect";

/** Only the callback needs it, so only the callback is sent it. */
export const PENDING_COOKIE_PATH = "/api/gmail";

export function startConnect(
  scope: WorkspaceScope,
  input: { client: GoogleOAuthClient; origin: string; loginHint?: string; now?: number },
): { authorizationUrl: string; pendingCookie: string } {
  const { authorizationUrl, pending } = beginConnect({
    clientId: input.client.clientId,
    redirectUri: callbackUri(input.origin),
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    loginHint: input.loginHint,
    now: input.now,
  });

  return { authorizationUrl, pendingCookie: encodePending(pending) };
}

/**
 * How a connect attempt ended, in terms a page can explain.
 *
 * `failed` carries a reason and nothing Google said: the reason is our vocabulary, chosen
 * so the page can tell the user what to do, and it can never contain a credential.
 */
export type ConnectOutcome =
  | { kind: "connected"; workspaceId: string; connection: ConnectionSummary; restored: boolean }
  | {
      kind: "failed";
      reason: "denied" | "invalid_state" | "expired" | GoogleOAuthErrorKind;
    };

export async function completeConnect(input: {
  params: URLSearchParams;
  pendingCookie: string | undefined;
  sessionUserId: string;
  /** Opens the workspace the attempt names, checking the session user may. */
  openScope: (workspaceId: string) => Promise<WorkspaceScope>;
  client: GoogleOAuthClient;
  origin: string;
  key?: Buffer;
  now?: number;
}): Promise<ConnectOutcome> {
  const check = checkCallback({
    params: input.params,
    pending: decodePending(input.pendingCookie),
    sessionUserId: input.sessionUserId,
    now: input.now,
  });
  if (!check.ok) return { kind: "failed", reason: check.reason };

  // Before Google is asked anything: a workspace this user cannot open ends the attempt
  // here, with no code exchanged and no token ever held.
  const scope = await input.openScope(check.pending.workspaceId);
  if (scope.userId !== input.sessionUserId) return { kind: "failed", reason: "invalid_state" };

  try {
    const grant = await exchangeCode(input.client, {
      code: check.code,
      codeVerifier: check.pending.codeVerifier,
      redirectUri: callbackUri(input.origin),
      now: input.now,
    });

    const { connection, restored } = await recordGrant(scope, grant, { key: input.key });
    return { kind: "connected", workspaceId: scope.workspaceId, connection, restored };
  } catch (error) {
    if (error instanceof GoogleOAuthError) return { kind: "failed", reason: error.kind };
    throw error;
  }
}
