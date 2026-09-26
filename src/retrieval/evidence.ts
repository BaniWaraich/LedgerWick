/**
 * Why a message was worth looking at, as facts rather than a score.
 *
 * spec: docs/workflows/retrieve-invoices.md §9, §13 · docs/workflows/invoice-match-review.md §5
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md,
 * docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * The same shape as `src/matching/evidence.ts`, for the same reason: the review screen
 * shows the user why something was proposed, and a number cannot be un-summed into a
 * reason. Each item carries what it was computed from, and `describeEmail` turns it into a
 * sentence the user can check against the message.
 *
 * Headers only. Every fact here is computed from the sender, the subject and the time the
 * message arrived -- what `format=metadata` returns (`connect-gmail.md §5`). There is no
 * input to this file that could carry a body.
 *
 * ## What this evidence is for
 *
 * Choosing which messages to download, and telling the user why they were chosen. It is
 * never what links a document. The document's own contents do that, through matching,
 * which is why none of these facts appears in the settle step's conjunction (`0016`).
 */

import type { IsoDate } from "../statements/dates";
import { INVOICE_WORDS } from "./query";

/** How the sender relates to the vendor the payment went to. */
type SenderAgreement = "VENDOR_ADDRESS" | "VENDOR_NAME" | "NONE";

export type EmailEvidence =
  | {
      readonly kind: "SENDER";
      readonly agreement: SenderAgreement;
      /** The sender's address, for the sentence. */
      readonly address: string;
    }
  | {
      readonly kind: "SUBJECT";
      readonly vendorNamed: boolean;
      /** The invoice word the subject used, if it used one. */
      readonly invoiceWord: string | null;
    }
  | {
      readonly kind: "DATE";
      /** Days from the transaction to the message arriving. Negative: it came first. */
      readonly offsetDays: number;
    }
  | {
      readonly kind: "FORWARDED";
      readonly forwarded: boolean;
    };

/** What the evidence is weighed against. */
export interface EvidenceContext {
  /** Normalized vendor keys (`vendorLookupKeys`), as matching uses them. */
  readonly vendorKeys: readonly string[];
  readonly transactionDate: IsoDate;
  /** The connected mailbox's own address. A message from it was forwarded or sent by hand. */
  readonly mailboxAddress: string;
}

/** The headers evidence is read from. Exactly what `format=metadata` provides. */
export interface EmailHeaders {
  readonly from: string;
  readonly subject: string;
  readonly receivedAt: Date;
}

/**
 * Keys shorter than this are not looked for in headers.
 *
 * Not a tuning number but a floor on meaning: a two-letter key ("hp", "lg") appears inside
 * half the words in any subject line, and a fact that is true of nearly everything is not
 * evidence of anything.
 */
const MIN_KEY_LENGTH = 3;

/** `"Anthropic, PBC" <invoice@mail.anthropic.com>` → its display name and its address. */
export function parseFrom(from: string): { name: string; address: string } {
  const angled = /^(.*?)<([^>]+)>\s*$/.exec(from.trim());
  if (angled) {
    return { name: angled[1].replace(/["']/g, "").trim(), address: angled[2].trim().toLowerCase() };
  }
  const bare = from.trim().toLowerCase();
  return { name: "", address: bare.includes("@") ? bare : "" };
}

/** The same flattening `vendorKeyAppearsIn` applies to a bank description. */
function flatten(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function namesVendor(text: string, keys: readonly string[]): boolean {
  const haystack = flatten(text);
  return keys.some((key) => key.length >= MIN_KEY_LENGTH && haystack.includes(key));
}

/** A reply or forward prefix, in the forms mail clients actually write. */
const FORWARD_PREFIX = /^\s*(?:fwd?|fw)\s*:/i;

function invoiceWordIn(subject: string): string | null {
  const lower = subject.toLowerCase();
  // Longest first, so "tax invoice" is reported rather than the "invoice" inside it.
  const byLength = [...INVOICE_WORDS].sort((a, b) => b.length - a.length);
  return byLength.find((word) => new RegExp(`\\b${word}\\b`).test(lower)) ?? null;
}

function daysBetween(from: IsoDate, to: Date): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const day = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((day - start) / 86_400_000);
}

/**
 * Every fact the headers establish about one message.
 *
 * Always all four kinds, including the ones that say nothing, for the reason matching's
 * evidence gives: "the sender does not name the vendor" is part of the case, and a reader
 * deciding about a candidate should see it.
 */
export function emailEvidenceFor(headers: EmailHeaders, context: EvidenceContext): EmailEvidence[] {
  const { name, address } = parseFrom(headers.from);

  /*
   * The address before the display name. `receipts@anthropic.com` is the vendor's own
   * domain; a display name is whatever the sender typed, and a reseller can type anything.
   */
  const sender: SenderAgreement = namesVendor(address, context.vendorKeys)
    ? "VENDOR_ADDRESS"
    : namesVendor(name, context.vendorKeys)
      ? "VENDOR_NAME"
      : "NONE";

  const mailbox = context.mailboxAddress.toLowerCase();

  return [
    { kind: "SENDER", agreement: sender, address },
    {
      kind: "SUBJECT",
      vendorNamed: namesVendor(headers.subject, context.vendorKeys),
      invoiceWord: invoiceWordIn(headers.subject),
    },
    { kind: "DATE", offsetDays: daysBetween(context.transactionDate, headers.receivedAt) },
    {
      kind: "FORWARDED",
      forwarded: FORWARD_PREFIX.test(headers.subject) || (address !== "" && address === mailbox),
    },
  ];
}

function find<K extends EmailEvidence["kind"]>(evidence: readonly EmailEvidence[], kind: K) {
  return evidence.find((e) => e.kind === kind) as Extract<EmailEvidence, { kind: K }> | undefined;
}

/**
 * Whether the headers say anything at all about this payment.
 *
 * A message inside the window with a PDF attached, whose sender and subject name neither
 * the vendor nor an invoice, is there because Gmail's full-text search matched something in
 * its body or attachment we are not allowed to read. That is not evidence we can show
 * anyone, so it is kept -- the user can see it was found -- and not fetched.
 */
export function hasSignal(evidence: readonly EmailEvidence[]): boolean {
  const sender = find(evidence, "SENDER");
  const subject = find(evidence, "SUBJECT");
  return (
    (sender !== undefined && sender.agreement !== "NONE") ||
    (subject !== undefined && (subject.vendorNamed || subject.invoiceWord !== null))
  );
}

/**
 * How strongly the headers point at this payment, for ordering only.
 *
 * A sort key and not a confidence, exactly as in `src/matching/candidates.ts`: nothing
 * decides from it, and it is never persisted, so no later change can start treating the
 * number a list happened to be sorted by as a measurement.
 */
export function strength(evidence: readonly EmailEvidence[]): number {
  let score = 0;
  for (const item of evidence) {
    switch (item.kind) {
      case "SENDER":
        if (item.agreement === "VENDOR_ADDRESS") score += 40;
        else if (item.agreement === "VENDOR_NAME") score += 30;
        break;
      case "SUBJECT":
        if (item.vendorNamed) score += 30;
        if (item.invoiceWord !== null) score += 20;
        break;
      case "DATE":
        score += Math.max(0, 10 - Math.abs(item.offsetDays));
        break;
      case "FORWARDED":
        break;
    }
  }
  return score;
}

/** One fact as a sentence a business owner can check against the message. */
function describeEmail(evidence: EmailEvidence): string | null {
  switch (evidence.kind) {
    case "SENDER":
      switch (evidence.agreement) {
        case "VENDOR_ADDRESS":
          return `Sent from ${evidence.address}, the vendor's own address`;
        case "VENDOR_NAME":
          return "Sender is named as the vendor";
        case "NONE":
          return "Sender does not name the vendor";
      }
      break;

    case "SUBJECT":
      if (evidence.vendorNamed && evidence.invoiceWord !== null) {
        return `Subject names the vendor and says "${evidence.invoiceWord}"`;
      }
      if (evidence.vendorNamed) return "Subject names the vendor";
      if (evidence.invoiceWord !== null) return `Subject says "${evidence.invoiceWord}"`;
      return "Subject mentions neither the vendor nor an invoice";

    case "DATE": {
      const days = Math.abs(evidence.offsetDays);
      if (days === 0) return "Arrived the same day as the payment";
      const unit = days === 1 ? "day" : "days";
      return evidence.offsetDays > 0
        ? `Arrived ${days} ${unit} after the payment`
        : `Arrived ${days} ${unit} before the payment`;
    }

    case "FORWARDED":
      return evidence.forwarded ? "Forwarded into this mailbox" : null;
  }

  return null;
}

/** Every sentence worth showing, in order. */
export function describeAllEmail(evidence: readonly EmailEvidence[]): string[] {
  return evidence.map(describeEmail).filter((line): line is string => line !== null);
}
