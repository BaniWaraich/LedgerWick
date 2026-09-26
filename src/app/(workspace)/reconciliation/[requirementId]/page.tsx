/**
 * Resolving one requirement automation could not.
 *
 * spec: docs/workflows/invoice-match-review.md
 *
 * `§2`: "This is where every uncertain path in the system terminates. Gmail retrieval that
 * found several plausible documents, a manual upload that matched nothing, an unreadable
 * scan, a suspected duplicate — all of them end here, in front of the user, and all of
 * them leave here `RESOLVED` or deliberately left open."
 *
 * `§3` adds the rule that shapes the layout: "The user should not be able to tell from the
 * interface which pipeline produced the uncertainty — only what the decision in front of
 * them is." So there is one screen, and the entry point is not a heading on it.
 *
 * ## What is always shown, and why
 *
 * `§4` names three things and gives the reason for each. The transaction, "because the
 * decision is meaningless without it". What the system did, because "a user told 'no
 * invoice found' deserves to know whether that means 'we looked in three mailboxes across
 * two weeks' or 'we never got to look'". And the candidates, where any exist.
 *
 * ## Every word comes from the database
 *
 * `architecture.md §14`, and `§10` is what it buys: "The user may leave at any point. The
 * requirement keeps its state, nothing is lost, and it remains in the action queue." A
 * screen that held state of its own could not promise that.
 *
 * The wireframe (`wireframes/invoice_match_detail`) shows one candidate and two buttons.
 * The spec requires a list and four outcomes, so the spec wins and the wireframe's
 * two-column comparison and "why they match" banner are what carry over.
 */

import { notFound } from "next/navigation";

import Link from "next/link";

import { requireScope } from "../../../../auth/workspace";
import { currencyFor } from "../../../../money/currencies";
import { formatAmount } from "../../../../money/format";
import { linkableDocuments, reviewContext } from "../../../../review/context";
import { DecisionForm } from "./decision-form";
import { DuplicatePanel } from "./duplicate-panel";
import styles from "./page.module.css";

/**
 * A uuid column rejects a malformed value with an error rather than an empty result, so
 * the shape is checked before it reaches the database — the idiom the statements pages use.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(minor: bigint, code: string): string {
  const currency = currencyFor(code);
  return currency ? formatAmount(minor, currency) : `${code} ${minor}`;
}

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ requirementId: string }>;
}) {
  const scope = await requireScope();
  const { requirementId } = await params;

  if (!UUID.test(requirementId)) notFound();

  const context = await reviewContext(scope, requirementId);

  // Another workspace's requirement and one that never existed are the same answer.
  if (context === null) notFound();

  const { requirement, transaction, whatWeDid, candidates, duplicate } = context;
  const linkable = requirement.isResolved ? [] : await linkableDocuments(scope);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href="/reconciliation">
          Back to what needs you
        </Link>
        <h1 className={styles.title}>{requirement.vendorGuess ?? transaction.description}</h1>
        <p className={styles.subtitle}>
          {requirement.isResolved
            ? "This one is settled."
            : "Tell us what this payment was for, and we'll file it."}
        </p>
      </header>

      {/* §4: always shown, because the decision is meaningless without it. */}
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>The payment</h2>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Amount</dt>
            <dd>{money(transaction.amountMinor, transaction.currency)}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Date</dt>
            <dd>{transaction.valueDate}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Account</dt>
            <dd>{transaction.account}</dd>
          </div>
        </dl>
        {/* The description as the statement printed it, not a tidied version. */}
        <p className={styles.description}>{transaction.description}</p>
        {requirement.reason ? <p className={styles.body}>{requirement.reason}</p> : null}
      </section>

      {/* §4: "a user told 'no invoice found' deserves to know whether we looked." */}
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>What we did</h2>
        <ul className={styles.did}>
          <li>
            {whatWeDid.candidatesConsidered === 0
              ? "We haven't found a document that looks like a match for this payment."
              : `We looked at ${whatWeDid.candidatesConsidered} ${
                  whatWeDid.candidatesConsidered === 1 ? "document" : "documents"
                } that might be for this payment.`}
          </li>
          {whatWeDid.rejectedPreviously > 0 ? (
            <li>
              {`You've already told us ${whatWeDid.rejectedPreviously} ${
                whatWeDid.rejectedPreviously === 1 ? "of them wasn't" : "of them weren't"
              } right, so we're not showing ${
                whatWeDid.rejectedPreviously === 1 ? "it" : "them"
              } again.`}
            </li>
          ) : null}
          {whatWeDid.truncated ? (
            <li>There were more payments than we could compare, so this may not be everything.</li>
          ) : null}
          {/*
            §4: "we looked in three mailboxes across two weeks" or "we never got to look" --
            and which it was, mailbox by mailbox.
          */}
          {whatWeDid.searchedMailboxes.length === 0 ? (
            <li>We haven&rsquo;t searched any email for this payment.</li>
          ) : (
            whatWeDid.searchedMailboxes.map((mailbox) => (
              <li key={mailbox.email}>
                {mailbox.outcome === "COMPLETED"
                  ? `We searched ${mailbox.email} for mail from ${mailbox.windowStart} to ${mailbox.windowEnd}.`
                  : mailbox.outcome === "NEEDS_REAUTH"
                    ? `We couldn't search ${mailbox.email}: Google needs you to reconnect it.`
                    : `We couldn't finish searching ${mailbox.email}. We'll try again.`}
              </li>
            ))
          )}
        </ul>
      </section>

      {/* §8: a different question, and answering it changes what the candidates mean. */}
      {duplicate && !requirement.isResolved ? (
        <DuplicatePanel requirementId={requirement.id} duplicate={duplicate} />
      ) : null}

      {requirement.isResolved ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Already settled</h2>
          <p className={styles.body}>
            Someone has already dealt with this one. Nothing here needs you.
          </p>
        </section>
      ) : (
        <DecisionForm
          requirementId={requirement.id}
          transactionId={transaction.id}
          vendorGuess={requirement.vendorGuess}
          canGeneralize={requirement.canGeneralize}
          candidates={candidates}
          linkable={linkable.map((document) => ({
            id: document.id,
            filename: document.filename,
            addedOn: document.createdAt.toISOString().slice(0, 10),
          }))}
        />
      )}
    </div>
  );
}
