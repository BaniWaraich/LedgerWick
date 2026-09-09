/**
 * Which workspace a request acts in.
 *
 * Kept apart from `workspace.ts` so the rule can be tested against a real database
 * without a Next request: everything here is an ordinary function over `db`, `userId` and
 * a candidate id. `workspace.ts` supplies those three from the session and the cookie and
 * turns the outcomes below into redirects.
 *
 * The rule this file exists to enforce (docs/decisions/0006-authentication.md):
 *
 *   **A workspace id arriving from the client is never trusted by itself.**
 *
 * `userId` is a parameter here, but the only caller derives it from the server session
 * and there is no path that accepts one from a request. Every branch that produces a
 * scope goes through `openWorkspace`, which is where membership is checked — so a
 * candidate id can only ever name a workspace the user already owns.
 */

import type { Database } from "../db/client";
import { listWorkspaces, openWorkspace, type WorkspaceScope } from "../db/workspace-scope";

/** A workspace the user may open. Enough to render a picker, and nothing more. */
export type WorkspaceChoice = { id: string; name: string };

/**
 * What the caller should do next.
 *
 * These are not workspace states — `docs/state-machines.md` defines none, and feature A
 * must not invent any. They describe this request, not the workspace.
 */
export type ScopeResolution =
  | { kind: "scope"; scope: WorkspaceScope }
  | { kind: "no-workspaces" }
  | { kind: "choose"; workspaces: WorkspaceChoice[] };

/**
 * Resolve the workspace for a request.
 *
 * `candidateId` is untrusted — a cookie value or a route parameter. It is not checked
 * here; it is handed to `openWorkspace`, which throws `WorkspaceAccessError` when the
 * workspace is not the user's or does not exist. That error is deliberately
 * indistinguishable between the two, and this function does not catch it: a caller that
 * swallowed it could carry on without a scope, which is the failure this whole module
 * exists to prevent.
 *
 * With no candidate, a single workspace is adopted silently — asking someone with one
 * business which business they mean is noise. More than one is a genuine question.
 */
export async function resolveWorkspaceScope(
  db: Database,
  userId: string,
  candidateId?: string,
): Promise<ScopeResolution> {
  if (candidateId) {
    return { kind: "scope", scope: await openWorkspace(db, userId, candidateId) };
  }

  const workspaces = await listWorkspaces(db, userId);

  if (workspaces.length === 0) return { kind: "no-workspaces" };

  if (workspaces.length === 1) {
    return { kind: "scope", scope: await openWorkspace(db, userId, workspaces[0].id) };
  }

  return {
    kind: "choose",
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })),
  };
}
