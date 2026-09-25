/**
 * The authenticated shell.
 *
 * Everything inside this route group has a signed-in user and an active workspace: the
 * layout resolves both before rendering, so a page beneath it never has to ask whether it
 * is authorized. A user with no workspace is redirected here, by `requireScope`, to make
 * one — which is why /workspaces and /workspaces/new sit outside this group.
 *
 * A route group, so `/home` keeps its URL.
 *
 * Follows wireframes/home_workspace. The navigation carries only what has been built:
 * the remaining items in that wireframe -- Matching, Exports -- arrive with the features
 * that own their routes, rather than as links to nothing.
 */

import Link from "next/link";

import { signOut } from "../../auth/config";
import { listAvailableWorkspaces, requireScope } from "../../auth/workspace";
import styles from "./layout.module.css";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const scope = await requireScope();
  const workspaces = await listAvailableWorkspaces();
  const active = workspaces.find((workspace) => workspace.id === scope.workspaceId);

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <span className="material-symbols-outlined">account_balance</span>
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>Ledgerwick</span>
            <span className={styles.workspaceName}>{active?.name ?? "Workspace"}</span>
          </span>
        </div>

        <nav className={styles.nav} aria-label="Main">
          <Link className={styles.navLink} href="/home">
            <span className="material-symbols-outlined" aria-hidden="true">
              home
            </span>
            Home
          </Link>
          <Link className={styles.navLink} href="/statements/upload">
            <span className="material-symbols-outlined" aria-hidden="true">
              upload_file
            </span>
            Statements
          </Link>
          <Link className={styles.navLink} href="/documents/upload">
            <span className="material-symbols-outlined" aria-hidden="true">
              receipt_long
            </span>
            Upload invoice
          </Link>
          <Link className={styles.navLink} href="/reconciliation">
            <span className="material-symbols-outlined" aria-hidden="true">
              fact_check
            </span>
            Invoices needed
          </Link>
          <Link className={styles.navLink} href="/connections">
            <span className="material-symbols-outlined" aria-hidden="true">
              mail
            </span>
            Connections
          </Link>
        </nav>

        <div className={styles.footer}>
          {workspaces.length > 1 ? (
            <Link className={styles.footerAction} href="/workspaces">
              <span className="material-symbols-outlined" aria-hidden="true">
                swap_horiz
              </span>
              Switch workspace
            </Link>
          ) : null}

          <form action={signOutAction}>
            <button className={styles.footerAction} type="submit">
              <span className="material-symbols-outlined" aria-hidden="true">
                logout
              </span>
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className={styles.content}>{children}</main>
    </div>
  );
}
