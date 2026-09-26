/**
 * A workspace's Gmail Connections: recording a grant, reading one back, and letting go.
 *
 * spec: docs/workflows/connect-gmail.md §4, §6–§11 · docs/state-machines.md §6
 *
 * Every function takes a `WorkspaceScope`, so every read of a credential is scoped to one
 * workspace's connection (§6) by the same object that scopes everything else. There is no
 * function here that reaches a connection by id alone.
 *
 * Two kinds of value leave this module, and only two:
 *
 * - `ConnectionSummary`, which is what a page may render. It is built field by field and
 *   carries no credential of any kind — never the ciphertext, not even a flag derived from
 *   it — so no page can hand one to the browser by spreading a row.
 * - An access token from `accessTokenFor`, for feature K to call Gmail with. It goes to
 *   Google and nowhere else.
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { gmailConnections } from "../db/schema";
import { isUniqueViolation } from "../db/errors";
import type { WorkspaceScope } from "../db/workspace-scope";
import { nextConnectionState, type ConnectionState } from "./connection-state";
import { decryptToken, encryptToken, GmailTokenDecryptError } from "./crypto";
import {
  GoogleOAuthError,
  refreshAccessToken,
  revokeToken,
  type GoogleOAuthClient,
  type Grant,
} from "./oauth";

type ConnectionRow = typeof gmailConnections.$inferSelect;

/** One connection, as a page may show it. No credential, in any form. */
export type ConnectionSummary = {
  id: string;
  email: string;
  state: ConnectionState;
  grantedScopes: string;
  connectedAt: Date;
  lastUsedAt: Date | null;
  disconnectedAt: Date | null;
};

function toSummary(row: ConnectionRow): ConnectionSummary {
  // Named field by field. A spread here is how a ciphertext reaches a client component.
  return {
    id: row.id,
    email: row.email,
    state: row.state,
    grantedScopes: row.grantedScopes,
    connectedAt: row.connectedAt,
    lastUsedAt: row.lastUsedAt,
    disconnectedAt: row.disconnectedAt,
  };
}

/** No connection by that id in this workspace. Deliberately the same for "someone else's". */
export class ConnectionNotFoundError extends Error {
  constructor() {
    super("No such Gmail connection in this workspace");
    this.name = "ConnectionNotFoundError";
  }
}

/**
 * The connection cannot be used until the user acts: it needs reauthorization, or was
 * disconnected. Feature K turns this into `BLOCKED` rather than retrying
 * (`connect-gmail.md §7`).
 */
export class ConnectionUnavailableError extends Error {
  constructor(readonly state: Exclude<ConnectionState, "CONNECTED">) {
    super(`Gmail connection is ${state}`);
    this.name = "ConnectionUnavailableError";
  }
}

const bySubject = (googleSubject: string) => eq(gmailConnections.googleSubject, googleSubject);
const byId = (id: string) => eq(gmailConnections.id, id);

async function find(scope: WorkspaceScope, id: string): Promise<ConnectionRow> {
  const row = await scope.selectOne(gmailConnections, byId(id));
  if (!row) throw new ConnectionNotFoundError();
  return row;
}

/** Every connection in the workspace, disconnected ones included, oldest first. */
export async function listConnections(scope: WorkspaceScope): Promise<ConnectionSummary[]> {
  const rows = await scope.select(gmailConnections);
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toSummary);
}

/** One connection, for a page that names it. */
export async function getConnection(scope: WorkspaceScope, id: string): Promise<ConnectionSummary> {
  return toSummary(await find(scope, id));
}

/**
 * Record a completed consent against this workspace.
 *
 * The first grant for an account creates its connection; every later one — a reconnect of
 * a healthy account, a reauthorization, connecting again after a disconnect — lands on the
 * same row (§9, `state-machines.md §6`). The unique index on (workspace, sub) is what makes
 * "the same row" certain rather than likely: two grants racing for a new account cannot
 * both insert, and the loser updates the winner's row instead.
 */
export async function recordGrant(
  scope: WorkspaceScope,
  grant: Grant,
  options: { key?: Buffer; now?: Date } = {},
): Promise<{ connection: ConnectionSummary; restored: boolean }> {
  const now = options.now ?? new Date();
  const encryptedRefreshToken = encryptToken(
    grant.refreshToken,
    { workspaceId: scope.workspaceId, googleSubject: grant.googleSubject },
    options.key,
  );

  const values = {
    email: grant.email,
    grantedScopes: grant.grantedScopes,
    encryptedRefreshToken,
    connectedAt: now,
    disconnectedAt: null,
    updatedAt: now,
  };

  const restore = async (existing: ConnectionRow) => {
    const [row] = await scope.update(
      gmailConnections,
      { ...values, state: nextConnectionState(existing.state, "GRANTED") },
      byId(existing.id),
    );
    return { connection: toSummary(row), restored: true };
  };

  const existing = await scope.selectOne(gmailConnections, bySubject(grant.googleSubject));
  if (existing) return restore(existing);

  try {
    const [row] = await scope.insert(gmailConnections, {
      ...values,
      googleSubject: grant.googleSubject,
      state: nextConnectionState(null, "GRANTED"),
    });
    return { connection: toSummary(row), restored: false };
  } catch (error) {
    if (!isUniqueViolation(error, "gmail_connections_identity_idx")) throw error;
    const winner = await scope.selectOne(gmailConnections, bySubject(grant.googleSubject));
    if (!winner) throw error;
    return restore(winner);
  }
}

/**
 * Google said this connection's grant is no longer valid.
 *
 * Conditional on the row still being `CONNECTED`, so two workers learning the same thing
 * at once move it once, and a user who reconnected in the meantime is not undone.
 */
export async function markNeedsReauth(scope: WorkspaceScope, id: string): Promise<void> {
  const row = await find(scope, id);
  // Already marked, or disconnected meanwhile and holding no grant to be invalid.
  if (row.state !== "CONNECTED") return;

  await scope.update(
    gmailConnections,
    { state: nextConnectionState(row.state, "GRANT_INVALID"), updatedAt: new Date() },
    and(byId(id), eq(gmailConnections.state, "CONNECTED")),
  );
}

/**
 * A short-lived access token for one connection. Feature K's way in.
 *
 * Refuses without asking Google when the connection is not `CONNECTED` — retrieval must not
 * keep trying an account the user has to fix (§7). When Google says the grant is invalid,
 * the connection moves to `NEEDS_REAUTH` and the caller is told; a transient failure
 * rethrows as it came and leaves the state alone (§8).
 */
export async function accessTokenFor(
  scope: WorkspaceScope,
  id: string,
  client: GoogleOAuthClient,
  key?: Buffer,
): Promise<string> {
  const row = await find(scope, id);
  if (row.state !== "CONNECTED" || !row.encryptedRefreshToken) {
    throw new ConnectionUnavailableError(row.state === "CONNECTED" ? "NEEDS_REAUTH" : row.state);
  }

  const refreshToken = decryptToken(
    row.encryptedRefreshToken,
    { workspaceId: scope.workspaceId, googleSubject: row.googleSubject },
    key,
  );

  try {
    return await refreshAccessToken(client, refreshToken);
  } catch (error) {
    if (error instanceof GoogleOAuthError && error.kind === "invalid_grant") {
      await markNeedsReauth(scope, id);
      throw new ConnectionUnavailableError("NEEDS_REAUTH");
    }
    throw error;
  }
}

/**
 * What happened to the Google grant when a connection was disconnected.
 *
 * - `revoked`: Google no longer honours it.
 * - `shared`: another connection still holds this Google account, so the grant was left in
 *   place — Google revokes grants, not tokens, and revoking would break that connection too.
 * - `unconfirmed`: we asked and could not confirm, or had no readable token to ask with.
 *   Our copy is deleted either way.
 */
export type Revocation = "revoked" | "shared" | "unconfirmed";

/**
 * Whether any other connection, in any workspace, still holds credentials for this Google
 * account. A question about the grant, answered as a boolean and never as rows; supplied
 * by `src/auth/gmail-grants.ts`, the one place that may look across workspaces for it.
 */
export type GrantHeldElsewhere = (googleSubject: string, exceptId: string) => Promise<boolean>;

/**
 * Disconnect: delete the credentials, keep the record, and revoke the grant when nothing
 * else still depends on it (§10, `docs/decisions/0006` amended).
 *
 * The credentials are deleted *first*, in the same write that sets `DISCONNECTED` — the
 * table's check refuses one without the other — and before Google is called at all, so no
 * failure of the network can leave the user believing a mailbox is disconnected while we
 * still hold its token. Supporting documents are not touched: nothing here reads or writes
 * them, and nothing references this row in a way that could cascade.
 */
export async function disconnectConnection(
  scope: WorkspaceScope,
  id: string,
  deps: { client: GoogleOAuthClient; grantHeldElsewhere: GrantHeldElsewhere; key?: Buffer },
): Promise<{ connection: ConnectionSummary; revocation: Revocation }> {
  const row = await find(scope, id);
  const state = nextConnectionState(row.state, "DISCONNECTED");

  let refreshToken: string | null = null;
  if (row.encryptedRefreshToken) {
    try {
      refreshToken = decryptToken(
        row.encryptedRefreshToken,
        { workspaceId: scope.workspaceId, googleSubject: row.googleSubject },
        deps.key,
      );
    } catch (error) {
      // An unreadable token cannot be revoked, but must still be deleted.
      if (!(error instanceof GmailTokenDecryptError)) throw error;
    }
  }

  const now = new Date();
  const [updated] = await scope.update(
    gmailConnections,
    { state, encryptedRefreshToken: null, disconnectedAt: now, updatedAt: now },
    and(byId(id), eq(gmailConnections.state, row.state)),
  );
  // Moved by someone else between the read and the write. Start again from what it is
  // now: already disconnected refuses, reconnected meanwhile is disconnected again.
  if (!updated) return disconnectConnection(scope, id, deps);

  let revocation: Revocation;
  if (await deps.grantHeldElsewhere(row.googleSubject, row.id)) revocation = "shared";
  else if (refreshToken && (await revokeToken(deps.client, refreshToken))) revocation = "revoked";
  else revocation = "unconfirmed";

  return { connection: toSummary(updated), revocation };
}
