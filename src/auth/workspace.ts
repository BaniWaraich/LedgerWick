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
import { WorkspaceAccessError, type WorkspaceScope } from "../db/workspace-scope";
import { requireUser } from "./session";
import { resolveWorkspaceScope } from "./workspace-resolution";

/**
 * Holds the active workspace id.
 *
 * Untrusted, like any cookie. It is a convenience so the id need not be threaded through
 * every route — not a credential. `openWorkspace` re-checks it on every single request,
 * so a forged or stale value grants nothing; it only produces a redirect.
 */
export const ACTIVE_WORKSPACE_COOKIE = "lw_active_workspace";

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
