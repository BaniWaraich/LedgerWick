/**
 * Noticing that an invoice is one the business already has.
 *
 * spec: docs/workflows/manual-invoice-upload.md §13 · docs/domain-model.md Rule 11
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * ## The case this exists for
 *
 * `§13`: an invoice was retrieved from the mailbox, and the owner later uploads their own
 * copy of it. Same document, two routes in. Without this, the business's records grow a
 * second invoice nobody asked for, and the accounts show a charge twice.
 *
 * ## Two tiers, and why the first one has no model in it
 *
 * Principle 2 -- deterministic before probabilistic. Where the vendor, the total, the
 * currency and the invoice number all agree, there is nothing for a model to weigh and
 * asking one would add a failure mode to a decision that does not have one. It is only
 * the partial agreement -- same vendor and amount, different numbers; same number,
 * different dates -- that needs a reader.
 *
 * Tier 3 is the common case and must stay cheap: a business on a monthly subscription
 * receives a similar invoice every month, and those are different charges.
 *
 * ## UNSURE is a duplicate
 *
 * `§13` says the system "should not silently create a second invoice", and the remedy is
 * always the same -- show the user both documents. So an inconclusive answer flags rather
 * than passes. The cost of being wrong in that direction is one comparison the owner did
 * not need to make; the other direction is a charge recorded twice.
 *
 * ## Nothing here merges anything
 *
 * The strongest thing this does is write `suspected_duplicate_of_invoice_id`. Deciding
 * they are one invoice, keeping both files and choosing which is primary is the user's,
 * through `invoice-match-review.md §8`. Nothing is deleted: the user asked to deduplicate
 * a record, not to destroy a file.
 */

import { and, eq, isNull, ne } from "drizzle-orm";

import { invoices } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { DuplicateBrief, JudgeSameInvoice } from "./contracts";
import { daysBetween } from "./evidence";
import { DUPLICATE_DATE_DAYS, DUPLICATE_MIN_AGREEING_FIELDS } from "./thresholds";

export interface DuplicateFinding {
  /** The invoice this one appears to be a second copy of. */
  readonly ofInvoiceId: string;
  /** Which fields agreed, in the user's language. */
  readonly reason: string;
}

/** One invoice, reduced to the fields a duplicate is judged on. */
interface Comparable {
  readonly id: string;
  readonly vendorId: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly totalMinor: bigint | null;
  readonly currency: string | null;
}

/** Case and punctuation only. `INV-1` and `inv 1` are one number written twice. */
function sameNumber(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const left = normalize(a);
  return left !== "" && left === normalize(b);
}

function sameTotal(a: Comparable, b: Comparable): boolean {
  return (
    a.totalMinor !== null &&
    a.totalMinor === b.totalMinor &&
    a.currency !== null &&
    a.currency === b.currency
  );
}

function sameDate(a: Comparable, b: Comparable): boolean {
  if (a.invoiceDate === null || b.invoiceDate === null) return false;
  return Math.abs(daysBetween(a.invoiceDate, b.invoiceDate)) <= DUPLICATE_DATE_DAYS;
}

function sameVendor(a: Comparable, b: Comparable): boolean {
  return a.vendorId !== null && a.vendorId === b.vendorId;
}

/** Which of the four fields agree, named so the reason can say so. */
function agreements(a: Comparable, b: Comparable): string[] {
  const agreed: string[] = [];
  if (sameVendor(a, b)) agreed.push("vendor");
  if (sameTotal(a, b)) agreed.push("amount");
  if (sameDate(a, b)) agreed.push("date");
  if (sameNumber(a.invoiceNumber, b.invoiceNumber)) agreed.push("invoice number");
  return agreed;
}

/** A list of field names as a person would say it. */
function readable(fields: string[]): string {
  if (fields.length <= 1) return fields[0] ?? "nothing";
  return `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
}

function brief(invoice: Comparable, vendorName: string | null): DuplicateBrief {
  return {
    vendor: vendorName,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    amount: invoice.totalMinor === null ? null : `${invoice.currency ?? "?"} ${invoice.totalMinor}`,
  };
}

/**
 * Find the invoice this one may be a second copy of.
 *
 * Only considers invoices that share a vendor, which is what keeps this bounded: without
 * it, every upload would be compared against the whole history. An invoice with no vendor
 * resolved is not compared at all -- there is no cheap way to narrow it, and the fields
 * left would flag every invoice of the same round amount.
 */
export async function findDuplicate(
  scope: WorkspaceScope,
  invoice: Comparable,
  deps: { judge: JudgeSameInvoice; vendorName: string | null },
): Promise<DuplicateFinding | null> {
  if (invoice.vendorId === null) return null;

  const siblings = await scope.select(
    invoices,
    and(
      eq(invoices.vendorId, invoice.vendorId),
      ne(invoices.id, invoice.id),
      // An invoice already flagged as a copy of something is not the thing to point at;
      // pointing at the original keeps a third copy from forming a chain nobody can read.
      isNull(invoices.suspectedDuplicateOfInvoiceId),
    ),
  );

  for (const sibling of siblings) {
    const agreed = agreements(invoice, sibling);

    // Tier 1. Everything a duplicate would agree on does. No model: there is nothing to
    // weigh, and asking would add a failure mode to a decision that has none.
    const decisive =
      sameVendor(invoice, sibling) &&
      sameTotal(invoice, sibling) &&
      (sameNumber(invoice.invoiceNumber, sibling.invoiceNumber) ||
        (invoice.invoiceNumber === null && sibling.invoiceNumber === null)) &&
      sameDate(invoice, sibling);

    if (decisive) {
      return { ofInvoiceId: sibling.id, reason: `Same ${readable(agreed)}` };
    }

    // Tier 3. Too little in common to be worth a question. A monthly subscription
    // produces a similar invoice every month and those are different charges.
    if (agreed.length < DUPLICATE_MIN_AGREEING_FIELDS) continue;

    // Tier 2. Partial agreement is the only case a reader helps with.
    const judgement = await deps.judge({
      existing: brief(sibling, deps.vendorName),
      incoming: brief(invoice, deps.vendorName),
    });

    /*
     * A model that could not answer is not a model saying no.
     *
     * `Inference` distinguishes "could not answer" from a thrown error precisely so this
     * can be a decision rather than a crash, and the safe reading of silence here is the
     * same as the safe reading of UNSURE: ask the user.
     */
    if (!judgement.ok || judgement.value.same === "YES" || judgement.value.same === "UNSURE") {
      const reason = judgement.ok
        ? judgement.value.reason
        : `Same ${readable(agreed)}, and we could not check the rest`;
      return { ofInvoiceId: sibling.id, reason };
    }
  }

  return null;
}

/** Record that this invoice appears to be one the business already has. */
export async function flagDuplicate(
  scope: WorkspaceScope,
  invoiceId: string,
  finding: DuplicateFinding,
): Promise<void> {
  await scope.update(
    invoices,
    {
      suspectedDuplicateOfInvoiceId: finding.ofInvoiceId,
      duplicateReason: finding.reason,
    },
    eq(invoices.id, invoiceId),
  );
}
