/**
 * What an invoice and a transaction have in common, as facts rather than a score.
 *
 * spec: docs/workflows/manual-invoice-upload.md §9 · docs/architecture.md §10.1
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * ## Why this is a list and not a number
 *
 * `invoice-match-review.md §5` shows the user this:
 *
 *     Vendor matches ANTHROPIC in the transaction description
 *     Amount matches exactly
 *     Dated the same day as the transaction
 *     Invoice number not present in the transaction description
 *
 * and then says why: "A percentage tells the user nothing they can check; 'the amount
 * matches and the date is the same' tells them everything." A score cannot be un-summed.
 * Once four signals are one number, the sentence above is unrecoverable, and the screen
 * that decides whether a business's accounts are right has nothing to show.
 *
 * So every item here carries its own operands -- both amounts and their difference, the
 * offset in days, the description the vendor was looked for in. `describe` turns one into
 * a sentence, and the sentence is derived from the fact rather than stored beside it.
 *
 * ## Absence is a fact too
 *
 * An invoice with no number does not produce "no evidence"; it produces `ABSENT`, which
 * reads differently from `NOT_PRESENT` -- the invoice had a number and the transaction did
 * not mention it. `§5`'s own example line is the second of those. Collapsing them would
 * lose the distinction between "nothing to check" and "checked, and it disagreed".
 *
 * ## What this file does not do
 *
 * It does not decide. Nothing here knows what an automatic link requires; that is
 * `decide.ts`, and keeping the two apart is what lets the evidence be gathered once and
 * read by both the policy and, later, by feature H.
 */

import type { IsoDate } from "../statements/dates";

/** How closely two amounts agree. */
export type AmountAgreement = "EXACT" | "NEAR" | "FX_BAND" | "DIFFERENT";

/** How closely two dates agree. */
export type DateAgreement = "SAME_DAY" | "WITHIN_WINDOW" | "OUTSIDE";

/**
 * How the invoice's vendor was recognised in the transaction.
 *
 * `RESOLVED` and `ALIAS` are both the vendor record agreeing; they differ in how it was
 * reached, which matters because an alias may be one the model guessed rather than one the
 * user confirmed (`vendor_aliases.confirmed`). `NORMALIZED_CONTAINS` is weaker again: the
 * normalized name appears inside the normalized description, with no vendor record
 * involved. It is real evidence and it is not the same evidence.
 */
export type VendorAgreement = "RESOLVED" | "ALIAS" | "NORMALIZED_CONTAINS" | "NONE";

/** Where the invoice number turned up, if anywhere. */
export type NumberAgreement = "IN_EXTERNAL_REFERENCE" | "IN_DESCRIPTION" | "NOT_PRESENT" | "ABSENT";

/** Whether the two are even denominated in the same thing. */
export type CurrencyAgreement = "SAME" | "DIFFERENT" | "UNKNOWN";

export type Evidence =
  | {
      readonly kind: "AMOUNT";
      readonly agreement: AmountAgreement;
      readonly invoiceMinor: bigint | null;
      readonly transactionMinor: bigint;
      /** Transaction minus invoice, in minor units. Null when the invoice has no total. */
      readonly deltaMinor: bigint | null;
    }
  | {
      readonly kind: "DATE";
      readonly agreement: DateAgreement;
      /** Transaction date minus invoice date, in days. Negative means the payment came first. */
      readonly offsetDays: number | null;
    }
  | {
      readonly kind: "VENDOR";
      readonly agreement: VendorAgreement;
      readonly invoiceVendor: string | null;
      readonly transactionDescription: string;
    }
  | {
      readonly kind: "INVOICE_NUMBER";
      readonly agreement: NumberAgreement;
      readonly invoiceNumber: string | null;
    }
  | {
      readonly kind: "CURRENCY";
      readonly agreement: CurrencyAgreement;
      readonly invoiceCurrency: string | null;
      readonly transactionCurrency: string;
    };

/** The invoice side of a comparison, as the `invoices` row holds it. */
export interface InvoiceFacts {
  readonly invoiceNumber: string | null;
  readonly invoiceDate: IsoDate | null;
  readonly totalMinor: bigint | null;
  readonly currency: string | null;
  readonly vendorId: string | null;
  /** The vendor's display name, for the sentence. Never used for comparison. */
  readonly vendorName: string | null;
  /** Normalized lookup keys for this invoice's vendor names. */
  readonly vendorKeys: readonly string[];
}

/** The transaction side, as `canonical_transactions` holds it. */
export interface TransactionFacts {
  readonly id: string;
  readonly valueDate: IsoDate;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description: string;
  readonly descriptionNormalized: string;
  readonly externalReference: string | null;
}

/**
 * How the vendor was matched, decided by the caller.
 *
 * Passed in rather than worked out here because resolving a vendor is a database question
 * -- which `vendors` row, reached through which alias -- and this file is pure. The caller
 * knows whether it found a vendor record; this file knows how to say so.
 */
export interface VendorMatch {
  readonly agreement: VendorAgreement;
}

/** Days from `from` to `to`, positive when `to` is later. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * The normalized invoice number, for comparing against normalized transaction text.
 *
 * Case and punctuation only, as `description.ts` puts it: formatting, never meaning.
 * `INV-92831` on the invoice and `inv92831` in a bank narration are the same number
 * written by two systems with different opinions about hyphens.
 */
function normalizeNumber(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function amountEvidence(invoice: InvoiceFacts, transaction: TransactionFacts): Evidence {
  if (invoice.totalMinor === null) {
    return {
      kind: "AMOUNT",
      agreement: "DIFFERENT",
      invoiceMinor: null,
      transactionMinor: transaction.amountMinor,
      deltaMinor: null,
    };
  }

  const delta = transaction.amountMinor - invoice.totalMinor;
  const sameCurrency = invoice.currency === transaction.currency;

  /*
   * A difference across currencies is not a difference in the same sense.
   *
   * `domain-model.md` §FX: a rate serves match scoring only and never produces a booked
   * figure, and a currency mismatch is "weak corroborating evidence within a wide tolerance
   * band, never a standalone match test". So a ₹1,700 transaction against a $20 invoice is
   * recorded as FX_BAND -- something to show a person -- rather than as agreement or as a
   * refutation. No rate is applied here, and none is stored.
   */
  if (!sameCurrency) {
    return {
      kind: "AMOUNT",
      agreement: "FX_BAND",
      invoiceMinor: invoice.totalMinor,
      transactionMinor: transaction.amountMinor,
      deltaMinor: delta,
    };
  }

  if (delta === 0n) {
    return {
      kind: "AMOUNT",
      agreement: "EXACT",
      invoiceMinor: invoice.totalMinor,
      transactionMinor: transaction.amountMinor,
      deltaMinor: 0n,
    };
  }

  /*
   * "Near" is within one percent of the invoice, which is where a payment fee or a
   * rounding difference lives. It is evidence worth showing and it is never enough to link
   * on: `thresholds.ts` sets the automatic tolerance to zero.
   */
  const magnitude = delta < 0n ? -delta : delta;
  const near = magnitude * 100n <= invoice.totalMinor;

  return {
    kind: "AMOUNT",
    agreement: near ? "NEAR" : "DIFFERENT",
    invoiceMinor: invoice.totalMinor,
    transactionMinor: transaction.amountMinor,
    deltaMinor: delta,
  };
}

function dateEvidence(
  invoice: InvoiceFacts,
  transaction: TransactionFacts,
  windowBefore: number,
  windowAfter: number,
): Evidence {
  if (invoice.invoiceDate === null) {
    return { kind: "DATE", agreement: "OUTSIDE", offsetDays: null };
  }

  const offset = daysBetween(invoice.invoiceDate, transaction.valueDate);

  if (offset === 0) return { kind: "DATE", agreement: "SAME_DAY", offsetDays: 0 };

  const inside = offset > 0 ? offset <= windowAfter : -offset <= windowBefore;

  return {
    kind: "DATE",
    agreement: inside ? "WITHIN_WINDOW" : "OUTSIDE",
    offsetDays: offset,
  };
}

function numberEvidence(invoice: InvoiceFacts, transaction: TransactionFacts): Evidence {
  if (invoice.invoiceNumber === null) {
    return { kind: "INVOICE_NUMBER", agreement: "ABSENT", invoiceNumber: null };
  }

  const needle = normalizeNumber(invoice.invoiceNumber);

  if (needle === "") {
    return { kind: "INVOICE_NUMBER", agreement: "ABSENT", invoiceNumber: invoice.invoiceNumber };
  }

  /*
   * The bank's own reference first. `canonical_transactions.external_reference` is a UTR
   * or equivalent, and where an invoice number turns up there it is a far stronger claim
   * than the same string appearing somewhere in a free-text narration.
   */
  if (
    transaction.externalReference !== null &&
    normalizeNumber(transaction.externalReference).includes(needle)
  ) {
    return {
      kind: "INVOICE_NUMBER",
      agreement: "IN_EXTERNAL_REFERENCE",
      invoiceNumber: invoice.invoiceNumber,
    };
  }

  if (normalizeNumber(transaction.description).includes(needle)) {
    return {
      kind: "INVOICE_NUMBER",
      agreement: "IN_DESCRIPTION",
      invoiceNumber: invoice.invoiceNumber,
    };
  }

  return {
    kind: "INVOICE_NUMBER",
    agreement: "NOT_PRESENT",
    invoiceNumber: invoice.invoiceNumber,
  };
}

function currencyEvidence(invoice: InvoiceFacts, transaction: TransactionFacts): Evidence {
  if (invoice.currency === null) {
    return {
      kind: "CURRENCY",
      agreement: "UNKNOWN",
      invoiceCurrency: null,
      transactionCurrency: transaction.currency,
    };
  }

  return {
    kind: "CURRENCY",
    agreement: invoice.currency === transaction.currency ? "SAME" : "DIFFERENT",
    invoiceCurrency: invoice.currency,
    transactionCurrency: transaction.currency,
  };
}

/**
 * Every observable fact relating one invoice to one transaction.
 *
 * Always returns all five kinds, including the ones that disagree. A candidate is shown to
 * a user with its whole case, and "the invoice number is not in the description" is part of
 * the case for judging it — `invoice-match-review.md §5` prints exactly that line.
 */
export function evidenceFor(
  invoice: InvoiceFacts,
  transaction: TransactionFacts,
  vendor: VendorMatch,
  window: { before: number; after: number },
): Evidence[] {
  return [
    amountEvidence(invoice, transaction),
    dateEvidence(invoice, transaction, window.before, window.after),
    {
      kind: "VENDOR",
      agreement: vendor.agreement,
      invoiceVendor: invoice.vendorName,
      transactionDescription: transaction.description,
    },
    numberEvidence(invoice, transaction),
    currencyEvidence(invoice, transaction),
  ];
}

/** Whether the invoice's normalized vendor keys appear in a transaction's description. */
export function vendorKeyAppearsIn(
  keys: readonly string[],
  descriptionNormalized: string,
): boolean {
  const haystack = descriptionNormalized.replace(/[^a-z0-9]/g, "");
  return keys.some((key) => key !== "" && haystack.includes(key));
}

/**
 * One piece of evidence, as a sentence a business owner can check against the document.
 *
 * The register is `invoice-match-review.md §5`'s: a statement of fact, no hedging, no
 * number that is not one of the two being compared. Returns null where there is genuinely
 * nothing to say, so a caller can render the list without filtering for empty strings.
 */
export function describe(evidence: Evidence): string | null {
  switch (evidence.kind) {
    case "AMOUNT":
      switch (evidence.agreement) {
        case "EXACT":
          return "Amount matches exactly";
        case "NEAR":
          return "Amount is close but not exact";
        case "FX_BAND":
          return "Amount is in a different currency";
        case "DIFFERENT":
          return evidence.invoiceMinor === null
            ? "No amount was read from this document"
            : "Amount does not match";
      }
      break;

    case "DATE":
      switch (evidence.agreement) {
        case "SAME_DAY":
          return "Dated the same day as the transaction";
        case "WITHIN_WINDOW": {
          const offset = evidence.offsetDays ?? 0;
          const days = Math.abs(offset);
          const unit = days === 1 ? "day" : "days";
          return offset > 0
            ? `Dated ${days} ${unit} before the transaction`
            : `Dated ${days} ${unit} after the transaction`;
        }
        case "OUTSIDE":
          return evidence.offsetDays === null
            ? "No date was read from this document"
            : "Dated well away from the transaction";
      }
      break;

    case "VENDOR":
      switch (evidence.agreement) {
        case "RESOLVED":
          return `Vendor matches ${evidence.transactionDescription} in the transaction description`;
        case "ALIAS":
          return `Vendor is a known alias of ${evidence.transactionDescription}`;
        case "NORMALIZED_CONTAINS":
          return `Vendor name appears in ${evidence.transactionDescription}`;
        case "NONE":
          return "Vendor does not match the transaction description";
      }
      break;

    case "INVOICE_NUMBER":
      switch (evidence.agreement) {
        case "IN_EXTERNAL_REFERENCE":
          return "Invoice number appears in the bank's reference";
        case "IN_DESCRIPTION":
          return "Invoice number appears in the transaction description";
        case "NOT_PRESENT":
          return "Invoice number not present in the transaction description";
        case "ABSENT":
          return null;
      }
      break;

    case "CURRENCY":
      switch (evidence.agreement) {
        case "DIFFERENT":
          return `Invoice is in ${evidence.invoiceCurrency}, the payment in ${evidence.transactionCurrency}`;
        case "UNKNOWN":
          return "No currency was read from this document";
        case "SAME":
          return null;
      }
  }

  return null;
}

/** Every sentence worth showing for a candidate, in the order the review screen prints them. */
export function describeAll(evidence: readonly Evidence[]): string[] {
  return evidence.map(describe).filter((line): line is string => line !== null);
}

/**
 * Evidence on its way into `jsonb`, and back.
 *
 * JSON has no integer big enough to be trusted with money, so the amounts go to text and
 * come back as `bigint`. The alternative -- holding them as `number` -- is the one thing
 * `docs/architecture.md` rules out at the top of the schema: "Money is stored as integer
 * minor units ... never as a float."
 *
 * The conversion is here, beside the type it converts, rather than in `match.ts`. A caller
 * that writes evidence with `JSON.stringify` and no thought gets a runtime error today
 * ("Do not know how to serialize a BigInt"), which is how this was found; a caller that
 * reads it back without `fromStored` would get strings where it expected amounts, silently.
 */
export type StoredEvidence = Omit<Evidence, "invoiceMinor" | "transactionMinor" | "deltaMinor"> &
  Record<string, unknown>;

/** Amounts to text, so `jsonb` can hold them. */
export function toStored(evidence: readonly Evidence[]): unknown[] {
  return evidence.map((item) =>
    item.kind === "AMOUNT"
      ? {
          ...item,
          invoiceMinor: item.invoiceMinor === null ? null : item.invoiceMinor.toString(),
          transactionMinor: item.transactionMinor.toString(),
          deltaMinor: item.deltaMinor === null ? null : item.deltaMinor.toString(),
        }
      : item,
  );
}

/** Text back to amounts, for anything that has to compare them again. */
export function fromStored(stored: unknown): Evidence[] {
  if (!Array.isArray(stored)) return [];

  return stored.map((item) => {
    const row = item as Record<string, unknown>;
    if (row.kind !== "AMOUNT") return row as unknown as Evidence;

    return {
      ...row,
      invoiceMinor: row.invoiceMinor === null ? null : BigInt(String(row.invoiceMinor)),
      transactionMinor: BigInt(String(row.transactionMinor)),
      deltaMinor: row.deltaMinor === null ? null : BigInt(String(row.deltaMinor)),
    } as Evidence;
  });
}
