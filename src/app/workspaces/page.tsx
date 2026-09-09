/**
 * Pick a workspace.
 *
 * Reachable without an active workspace, which is why it sits outside the authenticated
 * shell: that shell resolves a workspace before it renders, and this is where someone goes
 * when there isn't one, or when the one they had is no longer theirs.
 */

import Link from "next/link";

import { listAvailableWorkspaces } from "../../auth/workspace";
import { selectWorkspaceAction } from "./actions";
import styles from "./workspaces.module.css";

export default async function WorkspacesPage() {
  const workspaces = await listAvailableWorkspaces();

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.intro}>
          <h1 className={styles.title}>Your workspaces</h1>
          <p className={styles.subtitle}>Each workspace is one business, kept separate.</p>
        </div>

        <div className={styles.card}>
          {workspaces.length === 0 ? (
            <p className={styles.empty}>You do not have a workspace yet.</p>
          ) : (
            <ul className={styles.list}>
              {workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <form action={selectWorkspaceAction}>
                    <input type="hidden" name="workspaceId" value={workspace.id} />
                    <button className={styles.workspaceButton} type="submit">
                      <span className="material-symbols-outlined" aria-hidden="true">
                        account_balance
                      </span>
                      {workspace.name}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <Link className={styles.secondaryLink} href="/workspaces/new">
            Create a workspace
          </Link>
        </div>
      </div>
    </main>
  );
}
