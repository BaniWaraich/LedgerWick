/**
 * What happened to one uploaded document.
 *
 * spec: docs/workflows/manual-invoice-upload.md §10, §11, §14, §16
 *
 * Five endings, and the screen's job is to be honest about which one this is. `§17` draws
 * the distinction it exists to keep: "Upload does not equal successful reconciliation." A
 * file being stored, a document being read, and a payment being found are three separate
 * things, and a screen that runs them together leaves the user believing something is
 * filed when it is not.
 *
 * So an unreadable document, a document that was not an invoice, and one that matched
 * nothing all say so plainly and all offer the same way out: choose the payment yourself
 * (`§11`, `§12`). None of them is an error, and none of them loses the file.
 *
 * Every word comes from the database, as `architecture.md §14` asks, so a refresh or
 * coming back tomorrow shows the truth rather than whatever the browser was holding.
 *
 * The candidate evidence and the duplicate comparison are rendered by feature H. This
 * screen says a review is waiting and links to it.
 */

import { eq } from "drizzle-orm";

import Link from "next/link";
import { notFound } from "next/navigation";

import { requireScope } from "../../../../auth/workspace";
import {
  canonicalTransactions,
  invoiceDocuments,
  invoices,
  supportingDocuments,
} from "../../../../db/schema";
import { linkableTransactions } from "../../../../matching/match";
import { currencyFor } from "../../../../money/currencies";
import { formatAmount } from "../../../../money/format";
import { PollWhileProcessing } from "../../statements/[batchId]/poll";
import { LinkForm, type LinkableTransaction } from "./link-form";
import styles from "./page.module.css";

/** States the pipeline is still moving through, so the page should keep looking. */
const IN_PROGRESS = new Set(["STORED", "EXTRACTING", "CLASSIFYING"]);

function money(minor: bigint | null, code: string | null): string {
  if (minor === null || code === null) return "—";
  const currency = currencyFor(code);
  return currency ? formatAmount(minor, currency) : `${code} ${minor}`;
}

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const scope = await requireScope();
  const { documentId } = await params;

  const document = await scope.selectOne(
    supportingDocuments,
    eq(supportingDocuments.id, documentId),
  );

  // Indistinguishable from a document that does not exist. The same choice the rest of
  // the system makes about ids belonging to another workspace.
  if (document === null) notFound();

  const joins = await scope.select(invoiceDocuments, eq(invoiceDocuments.documentId, documentId));
  const invoice =
    joins.length === 0
      ? null
      : await scope.selectOne(invoices, eq(invoices.id, joins[0].invoiceId));

  const linkedTransactionId = invoice?.canonicalTransactionId ?? document.canonicalTransactionId;
  const linked =
    linkedTransactionId === null || linkedTransactionId === undefined
      ? null
      : await scope.selectOne(
          canonicalTransactions,
          eq(canonicalTransactions.id, linkedTransactionId),
        );

  const processing = IN_PROGRESS.has(document.state);
  const needsLink = linked === null && !processing;

  const transactions: LinkableTransaction[] = needsLink
    ? (await linkableTransactions(scope)).map((row) => ({
        id: row.id,
        valueDate: row.valueDate,
        description: row.description,
        amount: money(row.amountMinor, row.currency),
      }))
    : [];

  return (
    <div className={styles.page}>
      {/* The pipeline is background work; the page polls rather than pretending to stream. */}
      {processing ? <PollWhileProcessing /> : null}

      <header className={styles.header}>
        <h1 className={styles.title}>{document.filename}</h1>
        <p className={styles.subtitle}>{headline(document.state, linked !== null)}</p>
      </header>

      {invoice ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>What we read</h2>
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt>Total</dt>
              <dd>{money(invoice.totalMinor, invoice.currency)}</dd>
            </div>
            <div className={styles.fact}>
              <dt>Dated</dt>
              <dd>{invoice.invoiceDate ?? "—"}</dd>
            </div>
            <div className={styles.fact}>
              <dt>Invoice number</dt>
              <dd>{invoice.invoiceNumber ?? "Not on the document"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {invoice?.suspectedDuplicateOfInvoiceId ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>This may be one we already have</h2>
          {/* §13's sentence, and the user decides. Nothing has been merged or deleted. */}
          <p className={styles.body}>
            {invoice.duplicateReason ?? "It closely resembles an invoice already on file."}
          </p>
          <p className={styles.body}>
            Both documents are kept. You can compare them side by side and decide.
          </p>
          <Link className={styles.action} href="/reconciliation">
            Go to review
          </Link>
        </section>
      ) : null}

      {linked ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Attached to a payment</h2>
          <p className={styles.body}>
            {linked.description} · {money(linked.amountMinor, linked.currency)} · {linked.valueDate}
          </p>
        </section>
      ) : null}

      {needsLink ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Attach it yourself</h2>
          <p className={styles.body}>{explain(document.state)}</p>
          <LinkForm documentId={documentId} transactions={transactions} />
        </section>
      ) : null}

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>The original</h2>
        {/* §16: the file they uploaded, not an OCR rendering of it. Served through the
            authorized route, never a storage URL (architecture.md §19). */}
        <p className={styles.body}>
          The document is stored exactly as you uploaded it, and stays available whatever happens
          above.
        </p>
        <a className={styles.action} href={`/api/documents/${documentId}`}>
          Open the file
        </a>
      </section>
    </div>
  );
}

/** One sentence for the state this document is in. */
function headline(state: string, linked: boolean): string {
  if (linked) return "Matched to a payment on your statements.";

  switch (state) {
    case "STORED":
    case "EXTRACTING":
      return "Reading the document…";
    case "CLASSIFYING":
      return "Working out what it is…";
    case "UNREADABLE":
      // §11's exact sentence. Details, not text.
      return "We couldn't read the details from this document.";
    case "NOT_AN_INVOICE":
      // §5: uncertainty is not rejection, and the file is kept either way.
      return "We couldn't identify this document as an invoice.";
    default:
      return "We couldn't find a payment on your statements that matches this.";
  }
}

/** Why the user is being asked to do it by hand. */
function explain(state: string): string {
  switch (state) {
    case "UNREADABLE":
      return "We've kept the file. If you know which payment it was for, tell us and it counts just the same.";
    case "NOT_AN_INVOICE":
      return "You can still attach it to a payment — a receipt or a payment confirmation is evidence too.";
    default:
      return "Nothing on your statements matched closely enough for us to be sure. If you know which payment it was, choose it below.";
  }
}
