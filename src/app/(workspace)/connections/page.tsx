/**
 * The workspace's mailboxes: connect, reconnect, disconnect.
 *
 * spec: docs/workflows/connect-gmail.md §3 B and C, §5 "What the user is told", §9, §10
 *
 * Server-rendered throughout, with no client component: the disconnect confirmation is a
 * second view of this page (`?confirm=`) rather than a dialog, so the warning §10 requires
 * is always read before the button that acts on it exists. Nothing here ever holds a
 * credential -- `listConnections` returns summaries that carry none.
 *
 * Connecting goes through `/api/gmail/connect` as a plain link rather than `<Link>`: it is
 * a route handler that leaves the site, and client-side navigation or prefetching of it
 * would be wrong on both counts.
 */

import Link from "next/link";

import { listAvailableWorkspaces, requireScope } from "../../../auth/workspace";
import { listConnections, type ConnectionSummary } from "../../../gmail/connections";
import { disconnectAction } from "./actions";
import styles from "./page.module.css";

/** `docs/state-machines.md §6`, verbatim. */
const STATE_MESSAGES: Record<ConnectionSummary["state"], string> = {
  CONNECTED: "Connected",
  NEEDS_REAUTH: "Reconnect needed",
  DISCONNECTED: "Disconnected",
};

/** Why a connect attempt did not finish, in terms of what the user can do about it. */
const ERRORS: Record<string, string> = {
  denied: "You didn't give Ledgerwick access, so nothing was connected.",
  scope_not_granted:
    "Google didn't give Ledgerwick permission to read mail, so nothing was connected. Connect again and leave the Gmail permission ticked — without it we can't search for invoices.",
  invalid_state: "That connection attempt didn't match this session. Please start again.",
  expired: "That connection attempt took too long and expired. Please start again.",
  invalid_grant: "Google didn't accept that sign-in. Please start again.",
  transient: "We couldn't reach Google just now. Please try again in a moment.",
  not_found: "That mailbox isn't connected to this workspace.",
};
const FALLBACK_ERROR = "Something went wrong on our side connecting to Google. Please try again.";

/** `connect-gmail.md §10`: what happened to the grant, told plainly. */
const DISCONNECTED: Record<string, string> = {
  revoked: "Disconnected. We deleted our access to this mailbox and revoked it with Google.",
  shared:
    "Disconnected. We deleted this workspace's access. Ledgerwick still reads this Google account through another connection, so Google will keep listing it until that one is disconnected too.",
  unconfirmed:
    "Disconnected, and our copy of the access is deleted. We couldn't confirm that Google revoked it — you can check at myaccount.google.com/permissions.",
};

const GOOGLE_PERMISSIONS = "https://myaccount.google.com/permissions";

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function connectHref(workspaceId: string, reconnect?: string): string {
  const params = new URLSearchParams({ workspace: workspaceId });
  if (reconnect) params.set("reconnect", reconnect);
  return `/api/gmail/connect?${params}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const scope = await requireScope();
  const params = await searchParams;
  const workspaces = await listAvailableWorkspaces();
  const workspaceName =
    workspaces.find((w) => w.id === scope.workspaceId)?.name ?? "this workspace";
  const connections = await listConnections(scope);

  const error = one(params.error);
  const connectedId = one(params.connected);
  const disconnected = one(params.disconnected);
  const confirming = connections.find(
    (c) => c.id === one(params.confirm) && c.state !== "DISCONNECTED",
  );
  const justConnected = connections.find((c) => c.id === connectedId);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Connected mailboxes</h1>
        <p className={styles.subtitle}>
          Ledgerwick searches the Gmail accounts you connect for the invoices and receipts behind
          your payments.
        </p>
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {ERRORS[error] ?? FALLBACK_ERROR}
        </p>
      ) : null}
      {justConnected ? (
        <p className={styles.notice} role="status">
          {justConnected.email} is connected to {workspaceName}.
        </p>
      ) : null}
      {disconnected && DISCONNECTED[disconnected] ? (
        <p className={styles.notice} role="status">
          {DISCONNECTED[disconnected]}
        </p>
      ) : null}

      {confirming ? (
        <section className={styles.confirm} aria-labelledby="confirm-title">
          <h2 id="confirm-title" className={styles.sectionTitle}>
            Disconnect {confirming.email}?
          </h2>
          <p>
            Ledgerwick will delete its access to this mailbox and revoke it with Google. We
            won&rsquo;t search it for invoices again unless you reconnect it.
          </p>
          <p>
            <strong>Documents we&rsquo;ve already found in it stay in {workspaceName}.</strong>{" "}
            They&rsquo;re part of your financial records now, and disconnecting a mailbox
            doesn&rsquo;t remove them.
          </p>
          <div className={styles.actions}>
            <form action={disconnectAction}>
              <input type="hidden" name="connectionId" value={confirming.id} />
              <button className={styles.danger} type="submit">
                Disconnect
              </button>
            </form>
            <Link className={styles.secondary} href="/connections">
              Keep it connected
            </Link>
          </div>
        </section>
      ) : null}

      {connections.length > 0 ? (
        <ul className={styles.list}>
          {connections.map((connection) => (
            <li key={connection.id} className={styles.item}>
              <span className="material-symbols-outlined" aria-hidden="true">
                mail
              </span>
              <div className={styles.itemText}>
                <span className={styles.email}>{connection.email}</span>
                <span className={styles.meta}>
                  <span className={styles[`state_${connection.state}`]}>
                    {STATE_MESSAGES[connection.state]}
                  </span>
                  {connection.state === "DISCONNECTED" && connection.disconnectedAt
                    ? ` · since ${formatDate(connection.disconnectedAt)}`
                    : ` · connected ${formatDate(connection.connectedAt)}`}
                </span>
                {connection.state === "NEEDS_REAUTH" ? (
                  <span className={styles.meta}>
                    Google needs you to reconnect this account. Until then we can&rsquo;t search it
                    for invoices.
                  </span>
                ) : null}
              </div>
              <div className={styles.actions}>
                {connection.state === "CONNECTED" ? (
                  <Link className={styles.secondary} href={`/connections?confirm=${connection.id}`}>
                    Disconnect
                  </Link>
                ) : (
                  <a
                    className={styles.primary}
                    href={connectHref(scope.workspaceId, connection.id)}
                  >
                    {connection.state === "NEEDS_REAUTH" ? "Reconnect" : "Connect again"}
                  </a>
                )}
                {connection.state === "NEEDS_REAUTH" ? (
                  <Link className={styles.secondary} href={`/connections?confirm=${connection.id}`}>
                    Disconnect
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <section className={styles.connect} aria-labelledby="connect-title">
        <h2 id="connect-title" className={styles.sectionTitle}>
          Connect a Gmail account to {workspaceName}
        </h2>
        <ul className={styles.promises}>
          <li>Ledgerwick reads your mail only to find invoices and receipts for your payments.</li>
          <li>It never sends, changes, labels or deletes mail.</li>
          <li>You can disconnect at any time, here.</li>
        </ul>
        <p className={styles.meta}>
          Google will ask you to allow read-only access to Gmail. Connecting is optional — you can
          always upload invoices yourself. You can also review access at{" "}
          <a href={GOOGLE_PERMISSIONS} target="_blank" rel="noopener noreferrer">
            myaccount.google.com/permissions
          </a>
          .
        </p>
        <div className={styles.actions}>
          <a className={styles.primary} href={connectHref(scope.workspaceId)}>
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
            Connect Gmail
          </a>
        </div>
      </section>
    </div>
  );
}
