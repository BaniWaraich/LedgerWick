/**
 * Pick a workspace.
 *
 * Minimal on purpose — the shell built from the wireframes is feature A's last task.
 */

import Link from "next/link";

import { listAvailableWorkspaces } from "../../auth/workspace";
import { selectWorkspaceAction } from "./actions";

export default async function WorkspacesPage() {
  const workspaces = await listAvailableWorkspaces();

  return (
    <main>
      <h1>Your workspaces</h1>

      {workspaces.length === 0 ? (
        <p>You do not have a workspace yet.</p>
      ) : (
        <ul>
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <form action={selectWorkspaceAction}>
                <input type="hidden" name="workspaceId" value={workspace.id} />
                <button type="submit">{workspace.name}</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <Link href="/workspaces/new">New workspace</Link>
    </main>
  );
}
