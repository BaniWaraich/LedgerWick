/**
 * The workspace home.
 *
 * Minimal on purpose — the shell built from the wireframes is feature A's last task. What
 * this page does carry is the pattern every later feature follows: call `requireScope()`
 * and let it supply identity and authorization together, rather than reading a workspace
 * id from the request and checking it by hand.
 */

import { signOut } from "../../auth/config";
import { listAvailableWorkspaces, requireScope } from "../../auth/workspace";

export default async function HomePage() {
  // Resolves the session, then the workspace, then proves membership. A user with no
  // workspace never reaches the next line — requireScope redirects them to create one.
  const scope = await requireScope();
  const workspaces = await listAvailableWorkspaces();
  const active = workspaces.find((workspace) => workspace.id === scope.workspaceId);

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <main>
      <h1>{active?.name ?? "Workspace"}</h1>

      {workspaces.length > 1 ? <a href="/workspaces">Switch workspace</a> : null}

      <form action={signOutAction}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
