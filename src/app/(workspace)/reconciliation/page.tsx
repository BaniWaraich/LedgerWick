/**
 * The Missing Invoice Report: what the user still has to do.
 *
 * spec: docs/workflows/missing-invoice-report.md §5, §6, §7, §8 ·
 * docs/workflows/identifying-invoices.md §6 and §10
 * decision: docs/decisions/0014-report-counts-live-across-the-workspace.md
 *
 * Every word comes from the database, through `src/report/report.ts`. `architecture.md §14`
 * asks exactly that, and it is what makes a refresh, or returning from the review screen,
 * show the truth: review revalidates this path, and the next read is the new state.
 *
 * ## Why the run's stages are coarser here than in identifying-invoices §6
 *
 * §6 lists five stages and is explicit that the analysis "does not have a persisted state
 * model of its own". Showing all five would mean inventing progress the system is not
 * tracking. So the page shows the stages it can stand behind: the run is working, the run
 * is done, or the run needs help.
 *
 * ## What is not here yet
 *
 * The Excel download is feature L's, and is not shown as a button to nothing.
 *
 * ## The blocked prompt
 *
 * Feature J names each mailbox that needs reconnecting, with the Reconnect that fixes it
 * (`connect-gmail.md §9`). What it cannot yet say is how many invoices wait on *which*
 * mailbox: nothing records that until feature K writes `BLOCKED` against a connection, so
 * the blocked count stays one number for the workspace.
 */

import Link from "next/link";

import { requireScope } from "../../../auth/workspace";
import { listConnections } from "../../../gmail/connections";
import { currencyFor } from "../../../money/currencies";
import { formatAmount } from "../../../money/format";
import { missingInvoiceReport, type QueueRow } from "../../../report/report";
import { parseFilter, type Filter, type Summary } from "../../../report/summary";
import { PollWhileProcessing } from "../statements/[batchId]/poll";
import styles from "./page.module.css";

/** `docs/state-machines.md §2`, verbatim. What each state means to the person waiting. */
const STATE_MESSAGES: Record<string, string> = {
  IDENTIFIED: "Waiting for a document",
  NEEDS_REVIEW: "Needs your review",
  NOT_FOUND: "We couldn't find this one",
};

/** `docs/workflows/identifying-invoices.md §6`, for the stages that are actually tracked. */
const MESSAGES: Record<string, string> = {
  RUNNING: "Evaluating your transactions…",
  COMPLETED: "We've identified the documents you may need.",
  // §11: the user is told it is our problem, not theirs, and that their statements are safe.
  FAILED: "We ran into an issue analysing your transactions. Your statements are safe.",
};

/** §7's filters, in the order they are offered. */
const FILTER_LINKS: { filter: Filter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "not-found", label: "Not found" },
  { filter: "needs-review", label: "Needs review" },
  { filter: "waiting", label: "Waiting for a document" },
];

export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const scope = await requireScope();
  const filter = parseFilter((await searchParams).filter);

  const report = await missingInvoiceReport(scope, filter);
  const { run, summary } = report;
  const needsReconnecting = (await listConnections(scope)).filter(
    (connection) => connection.state === "NEEDS_REAUTH",
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <h1 className={styles.title}>Invoices needed</h1>
          {/* §8: starting again returns to statement upload, and loses nothing. */}
          <Link className={styles.start} href="/statements/upload">
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
            Start new reconciliation
          </Link>
        </div>
        <p className={styles.subtitle}>
          {run
            ? (MESSAGES[run.state] ?? run.state)
            : "Upload some statements and we'll take a look."}
        </p>
      </header>

      {run ? (
        <SummaryPanel
          summary={summary}
          transactionsProcessed={report.transactionsProcessed}
          runDate={run.startedAt}
          coverage={
            run.coverageStart && run.coverageEnd
              ? { start: run.coverageStart, end: run.coverageEnd }
              : null
          }
          accounts={report.accounts.map((account) => account.name)}
        />
      ) : null}

      {/*
        §6: a broken connection is one prompt, not a row per requirement. connect-gmail §9
        names the account and what it costs; the per-account count waits on feature K.
      */}
      {needsReconnecting.map((connection) => (
        <p key={connection.id} className={styles.blocked} role="status">
          <span className="material-symbols-outlined" aria-hidden="true">
            link_off
          </span>
          <span>
            We can&rsquo;t reach {connection.email}. Google needs you to reconnect this account;
            until then we can&rsquo;t search it for invoices.{" "}
            <a
              href={`/api/gmail/connect?workspace=${scope.workspaceId}&reconnect=${connection.id}`}
            >
              Reconnect
            </a>
          </span>
        </p>
      ))}

      {/*
        The blocked count, for the workspace as a whole: which connection each requirement
        waits on is recorded by feature K, so this states the number and nothing it cannot back.
      */}
      {summary.blocked > 0 ? (
        <p className={styles.blocked} role="status">
          <span className="material-symbols-outlined" aria-hidden="true">
            link_off
          </span>
          {summary.blocked} {summary.blocked === 1 ? "invoice is" : "invoices are"} waiting on a
          mailbox connection.
        </p>
      ) : null}

      {report.openQuestions > 0 ? (
        <Link className={styles.questions} href="/reconciliation/questions">
          <span className="material-symbols-outlined" aria-hidden="true">
            help
          </span>
          {/* identifying-invoices §6's "awaiting answers": it never blocked the run. */}
          We need your help with {report.openQuestions}{" "}
          {report.openQuestions === 1 ? "payment" : "payments"}.
        </Link>
      ) : null}

      {run ? (
        <nav className={styles.filters} aria-label="Filter">
          {FILTER_LINKS.map((link) => (
            <Link
              key={link.filter}
              className={styles.filter}
              href={
                link.filter === "all" ? "/reconciliation" : `/reconciliation?filter=${link.filter}`
              }
              aria-current={link.filter === filter ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}

      {report.queue.length === 0 ? (
        <EmptyState
          hasRun={Boolean(run)}
          filtered={filter !== "all"}
          anyRequired={summary.documentsRequired + summary.notRequired > 0}
        />
      ) : (
        <ol className={styles.list}>
          {report.queue.map((row, position) => (
            <QueueItem key={row.requirement.id} row={row} position={position} />
          ))}
        </ol>
      )}

      {/* Only while a run is actually moving; a finished run stops asking. */}
      {run?.state === "RUNNING" ? <PollWhileProcessing /> : null}
    </div>
  );
}

/**
 * §5. The summary orients; it does not act.
 *
 * Two denominators, never conflated: transactions processed is context, documents required
 * is what the lines beneath it sum to. What the user said needs no document is outside
 * both sums and said separately, so the number that left is not silently gone.
 */
function SummaryPanel({
  summary,
  transactionsProcessed,
  runDate,
  coverage,
  accounts,
}: {
  summary: Summary;
  transactionsProcessed: number;
  runDate: Date;
  coverage: { start: string; end: string } | null;
  accounts: string[];
}) {
  const lines: { label: string; value: number }[] = [
    { label: "matched", value: summary.matched },
    { label: "not found", value: summary.notFound },
    {
      label: summary.needsReview === 1 ? "needs review" : "need review",
      value: summary.needsReview,
    },
    { label: "waiting for a document", value: summary.waiting },
  ];
  if (summary.blocked > 0) lines.push({ label: "waiting on a mailbox", value: summary.blocked });

  return (
    <section className={styles.summary} aria-label="Summary">
      <p className={styles.processed}>
        {transactionsProcessed} {transactionsProcessed === 1 ? "transaction" : "transactions"}{" "}
        processed
      </p>
      <p className={styles.required}>{summary.documentsRequired} needed a document</p>
      <dl className={styles.lines}>
        {lines.map((line) => (
          <div className={styles.line} key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {summary.notRequired > 0 ? (
        <p className={styles.runDetail}>
          {summary.notRequired} {summary.notRequired === 1 ? "payment" : "payments"} marked as
          needing no document
        </p>
      ) : null}
      <p className={styles.runDetail}>
        Last run: {runDate.toLocaleDateString("en-IN", { dateStyle: "long" })}
      </p>
      {coverage ? (
        <p className={styles.runDetail}>
          Coverage: {coverage.start} → {coverage.end}
          {accounts.length > 0 ? ` · ${accounts.join(", ")}` : null}
        </p>
      ) : null}
    </section>
  );
}

function QueueItem({ row, position }: { row: QueueRow; position: number }) {
  const { requirement, transaction } = row;
  const name = requirement.vendorGuess ?? transaction.description;
  const currency = currencyFor(row.accountCurrency);

  /*
    A requirement still waiting has nothing to review -- nothing was searched and no
    candidate exists -- so it leads to uploading its document, already bound to this
    payment. The others lead into review (§6: "Both lead into invoice-match-review.md").
  */
  const href =
    requirement.state === "IDENTIFIED"
      ? `/documents/upload?transaction=${transaction.id}`
      : `/reconciliation/${requirement.id}`;
  const action = requirement.state === "IDENTIFIED" ? "Upload a document for" : "Review";

  return (
    <li className={styles.item}>
      <span className={styles.position}>{position + 1}</span>
      <div className={styles.detail}>
        <p className={styles.vendor}>{name}</p>
        <p className={styles.state}>{STATE_MESSAGES[requirement.state] ?? requirement.state}</p>
        <p className={styles.amount}>
          {currency
            ? formatAmount(transaction.amountMinor, currency)
            : `${transaction.currency} ${transaction.amountMinor}`}
        </p>
        <p className={styles.date}>{transaction.valueDate}</p>
        {requirement.businessContext ? (
          <p className={styles.context}>{requirement.businessContext}</p>
        ) : null}
        {requirement.reason ? <p className={styles.reason}>{requirement.reason}</p> : null}
      </div>
      <Link className={styles.review} href={href} aria-label={`${action} ${name}`}>
        <span className="material-symbols-outlined" aria-hidden="true">
          {requirement.state === "IDENTIFIED" ? "upload_file" : "chevron_right"}
        </span>
      </Link>
    </li>
  );
}

/**
 * identifying-invoices §10: zero requirements is a valid outcome, not a failure.
 *
 * Different facts, and they must not read alike: we have not looked yet, we looked and
 * nothing needed a document, everything that did has been dealt with, or this filter
 * happens to be empty.
 */
function EmptyState({
  hasRun,
  filtered,
  anyRequired,
}: {
  hasRun: boolean;
  filtered: boolean;
  anyRequired: boolean;
}) {
  if (filtered) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>Nothing here right now.</p>
        <Link className={styles.emptyAction} href="/reconciliation">
          Show everything
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>
        {!hasRun
          ? "Nothing to show yet."
          : anyRequired
            ? "Nothing needs your attention."
            : "We couldn't find any transactions that appear to need invoices."}
      </p>
      <p className={styles.emptyBody}>
        {hasRun
          ? "You can still upload invoices you already have, and we'll look for the payment."
          : "Upload your bank statements and we'll work out which payments need a document."}
      </p>
      <Link
        className={styles.emptyAction}
        href={hasRun ? "/documents/upload" : "/statements/upload"}
      >
        {hasRun ? "Upload an invoice" : "Upload statements"}
      </Link>
    </div>
  );
}
