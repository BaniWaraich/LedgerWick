/**
 * The workspace scope for work triggered by an event rather than a request.
 *
 * `requireScope()` reads a cookie and redirects, so it is meaningless inside an Inngest
 * function: there is no session, and there is nowhere to redirect to. Background work
 * gets its workspace from the event payload instead.
 *
 * That payload is not a credential. It is written by the request that sent the event,
 * where the session was checked — but an event can be replayed, an id can be edited in
 * the Inngest dashboard, and a workflow can outlive the membership that started it. So
 * this does not trust the payload: it goes through `openWorkspace`, which re-runs the
 * ownership check, exactly as every request does. A revoked user's queued job fails
 * closed.
 *
 * It lives in `src/auth` because that is where the bridge from an identity to a scope is
 * allowed to be written (`tests/auth/scope-is-unavoidable.test.ts`). Adding `src/inngest`
 * to that test's allowed list instead would have made the rule mean nothing — the test
 * says as much. One narrow, named door, not a wider wall.
 */

import "server-only";

import { getDb } from "../db/client";
import { openWorkspace, type WorkspaceScope } from "../db/workspace-scope";

/**
 * The scope for a background job, or a thrown `WorkspaceAccessError`.
 *
 * Throwing is right here where `requireScope` redirects: a workflow has no user in front
 * of it, and a job that cannot prove access should fail loudly and be visible as a failed
 * run rather than quietly doing nothing.
 */
export async function openWorkspaceForJob(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceScope> {
  return openWorkspace(getDb(), userId, workspaceId);
}
