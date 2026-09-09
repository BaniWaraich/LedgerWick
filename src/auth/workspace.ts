/**
 * The workspace scope for a request.
 *
 * Route and action code calls `requireScope()` and gets a `WorkspaceScope` or a redirect.
 * There is no other exported way to obtain one outside `src/db`, and every path through
 * here ends in `openWorkspace` — so the workspace id a client supplies is authorization-
 * checked before it can reach any data (ADR 0006; docs/definition-of-done.md, "No
 * workspace identifier comes from the client without being checked against the session").
 */

import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getDb } from "../db/client";
import {
  createWorkspace,
  listWorkspaces,
  openWorkspace,
  WorkspaceAccessError,
  type WorkspaceScope,
} from "../db/workspace-scope";
import { requireUser } from "./session";
import { resolveWorkspaceScope, type WorkspaceChoice } from "./workspace-resolution";

/**
 * Holds the active workspace id.
 *
 * Untrusted, like any cookie. It is a convenience so the id need not be threaded through
 * every route — not a credential. `openWorkspace` re-checks it on every single request,
 * so a forged or stale value grants nothing; it only produces a redirect.
 */
const ACTIVE_WORKSPACE_COOKIE = "lw_active_workspace";

/** Where the user goes when they have no workspace, or must pick one. */
const CREATE_WORKSPACE_PATH = "/workspaces/new";
const CHOOSE_WORKSPACE_PATH = "/workspaces";

async function readActiveWorkspaceCookie(): Promise<string | undefined> {
  return (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
}

/**
 * The scope for this request, or a redirect.
 *
 * `workspaceId` is for routes that name a workspace explicitly. Passing one does not skip
 * the check — it only chooses which id is offered to `openWorkspace`.
 *
 * A workspace that is not the user's redirects rather than throwing, because reaching one
 * is an ordinary thing that happens with a stale cookie after switching accounts. The
 * stale value is left in place: it is re-checked every request and grants nothing, and a
 * server component may not delete a cookie. Selecting a workspace overwrites it.
 */
export const requireScope = cache(async (workspaceId?: string): Promise<WorkspaceScope> => {
  const { userId } = await requireUser();
  const candidate = workspaceId ?? (await readActiveWorkspaceCookie());

  let resolution;
  try {
    resolution = await resolveWorkspaceScope(getDb(), userId, candidate);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) redirect(CHOOSE_WORKSPACE_PATH);
    throw error;
  }

  if (resolution.kind === "scope") return resolution.scope;

  redirect(resolution.kind === "no-workspaces" ? CREATE_WORKSPACE_PATH : CHOOSE_WORKSPACE_PATH);
});

/**
 * Cookie options.
 *
 * `httpOnly` because no client code has any reason to read it — the active workspace is
 * resolved on the server. `lax` so following a link into the app keeps the selection.
 */
function activeWorkspaceCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // A month. Long enough not to nag, short enough that an abandoned device forgets.
    maxAge: 60 * 60 * 24 * 30,
  } as const;
}

/** The workspaces the signed-in user may open. Grants nothing on its own. */
export async function listAvailableWorkspaces(): Promise<WorkspaceChoice[]> {
  const { userId } = await requireUser();

  const rows = await listWorkspaces(getDb(), userId);
  return rows.map((w) => ({ id: w.id, name: w.name }));
}

/**
 * Make `workspaceId` the active one.
 *
 * The authorization check runs first and the cookie is only written after it returns:
 * `openWorkspace` throws for a workspace that is not the user's, so a failed selection
 * cannot leave a cookie naming someone else's workspace behind.
 */
export async function activateWorkspace(workspaceId: string): Promise<void> {
  const { userId } = await requireUser();

  await openWorkspace(getDb(), userId, workspaceId);

  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, activeWorkspaceCookieOptions());
}

/**
 * Create a workspace for the signed-in user and make it active.
 *
 * The owner comes from the session, never from the form, so a crafted request cannot
 * create a workspace belonging to somebody else.
 */
export async function createWorkspaceForUser(name: string): Promise<{ id: string }> {
  const { userId } = await requireUser();

  const workspace = await createWorkspace(getDb(), userId, name);

  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspace.id, activeWorkspaceCookieOptions());

  return { id: workspace.id };
}
