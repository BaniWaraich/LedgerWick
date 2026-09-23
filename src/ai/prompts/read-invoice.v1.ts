/**
 * What a supporting document is, and what it says.
 *
 * spec: docs/workflows/manual-invoice-upload.md §5 and §6
 * decision: docs/decisions/0010-extraction-returns-locators.md
 *
 * One call, answering two questions `§5` and `§6` ask in sequence: is this an invoice, and
 * what does it say. They are one call because they are one reading of one page — a model
 * that has just decided a document is a receipt has already seen the total, and asking
 * again in a second round trip buys nothing but latency and a chance for the two answers to
 * disagree.
 *
 * Two constraints shape the schema, and both come from decisions written down elsewhere.
 *
 * **Every figure comes back as characters, not as a number.** `0003` keeps the model away
 * from values wherever a deterministic layer can check them; an invoice has no such layer
 * and no arithmetic check of any kind, which makes this structurally the higher-risk path
 * that decision warns about. `0010` is the answer: the model reports the span it read, and
 * `readAmount` and `readDate` — the same functions that parse every statement in the system
 * — turn it into a value. A model that returns 120000 for "1,20,000.00" has interpreted the
 * grouping and is caught; a model that returns the characters has not. The span is also
 * what a reviewer is shown in feature H, which `phase-1.md §7 H` requires instead of a
 * percentage.
 *
 * **Classification is three-valued and stays that way.** `state-machines.md §3` is explicit
 * that it "must not be flattened to a boolean", and `testing-strategy.md` says a false
 * positive costs more than asking the user. So `UNCERTAIN` is a first-class answer with its
 * own instructions, not a low score on a yes/no.
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

/**
 * A value as the document prints it.
 *
 * An object rather than a bare string so that the schema's shape says what the field is for.
 * `text` is evidence — the characters on the page — and the caller is what turns evidence
 * into a value. See `0010`.
 */
const printed = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "The characters exactly as printed on the document, including grouping, symbols and any currency written beside them. Do not convert, round, or strip anything.",
    ),
});

/**
 * Who issued the document.
 *
 * Three names rather than one because `§7` requires a legal name, a trade name and any
 * aliases on the page to all be capable of resolving to one vendor, and the invoice is
 * where all three are actually printed together. This is the one chance to learn that
 * `ABC Foods Private Limited` and `ABC Foods` are the same company from a document that
 * says so, rather than guessing it later from a bank narration.
 */
const vendor = z.object({
  legalName: z
    .string()
    .nullable()
    .describe(
      "The full registered name, if the document prints one: 'ABC Foods Private Limited'. Null if it does not.",
    ),
  tradeName: z
    .string()
    .nullable()
    .describe(
      "The name the business trades under, as a customer would say it: 'ABC Foods'. Null if the document gives only one name — put that name in legalName.",
    ),
  aliases: z
    .array(z.string().min(1))
    .describe(
      "Any other name the document uses for the same issuer: a brand, an abbreviation, a payment-processor rendering shown on the page. Empty when there are none. Never invent one.",
    ),
});

export const invoiceReadingSchema = z
  .object({
    classification: z
      .enum(["IS_INVOICE", "UNCERTAIN", "IS_NOT_INVOICE"])
      .describe(
        "IS_INVOICE when the document is confidently a bill, invoice or receipt addressed to the reader. IS_NOT_INVOICE when it is confidently something else. UNCERTAIN when you cannot tell — see the rules.",
      ),
    reason: z
      .string()
      .min(1)
      .describe(
        "One sentence a business owner would recognise, saying what this document is and how you could tell. This is shown to them, so write about the document, not about your process.",
      ),
    documentType: z
      .string()
      .nullable()
      .describe(
        "What kind of document it is, in a word or two as a person would say it: 'Tax invoice', 'Receipt', 'Payment confirmation', 'Delivery note'. Null if you cannot tell.",
      ),
    vendor: vendor
      .nullable()
      .describe("Who issued the document. Null when it names no issuer at all."),
    invoiceNumber: z
      .string()
      .nullable()
      .describe(
        "The invoice, bill or receipt number as printed. Null if the document carries none — many receipts do not, and that is not a defect.",
      ),
    invoiceDate: printed
      .nullable()
      .describe(
        "The date the document was issued, as printed. If there is no issue date, the date of the transaction it records. Null if the document shows no date at all.",
      ),
    dateOrder: z
      .enum(["DMY", "MDY", "YMD"])
      .describe(
        "The order of the parts of a numeric date on this document. A day above 12 anywhere settles it; otherwise use the issuer's country and the document's language.",
      ),
    currency: z
      .string()
      .nullable()
      .describe(
        "The ISO 4217 code of the amounts: INR, USD, EUR. Read it from the symbol or the words beside the total. Null if nothing on the document says.",
      ),
    decimalSeparator: z
      .enum([".", ","])
      .describe("The character separating whole units from fractions in the amounts."),
    total: printed
      .nullable()
      .describe(
        "The amount actually payable — the grand total, after tax and after any discount. Not the subtotal, not a line item. Null if the document shows no total.",
      ),
    tax: printed
      .nullable()
      .describe(
        "The total tax charged: GST, VAT, sales tax. Sum the components if the document splits them, and report the sum as printed if it prints one. Null if there is no tax line.",
      ),
    subtotal: printed
      .nullable()
      .describe("The amount before tax, as printed. Null if the document does not show one."),
  })
  .superRefine((reading, context) => {
    /*
     * A document confidently not an invoice has no invoice fields to report.
     *
     * Not tidiness. `domain-model.md §5.1` forks on this answer — only a document
     * classified as an invoice creates an Invoice — and a model that says "this is a
     * delivery note" while filling in a total has contradicted itself. Catching it here
     * makes the contradiction a schema failure the caller records, rather than a row in
     * the database asserting a charge nobody made.
     */
    if (reading.classification === "IS_NOT_INVOICE") {
      for (const field of ["total", "tax", "subtotal", "invoiceNumber"] as const) {
        if (reading[field] !== null) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} must be null when the document is not an invoice`,
          });
        }
      }
    }

    /*
     * A currency is required once there is an amount, and forbidden before there is one.
     *
     * `src/money/currencies.ts` stores money as integer minor units against a per-currency
     * exponent, so an amount whose currency is unknown cannot be stored at all — a yen read
     * against an assumed exponent of 2 is wrong by a factor of a hundred. Requiring the two
     * together is what stops a total arriving with nowhere to put it.
     */
    if (reading.total !== null && reading.currency === null) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "currency is required when a total was found",
      });
    }
  });

export type InvoiceReading = z.infer<typeof invoiceReadingSchema>;

export const readInvoicePrompt: PromptDefinition = {
  id: "read-invoice",
  version: 1,
  system: `You read supporting documents for a bookkeeping system used by small business
owners, most of them in India. A supporting document is whatever a business files as
evidence of a payment: an invoice, a bill, a receipt, a payment confirmation.

You are given one document. Answer two questions about it: what it is, and what it says.

## Report characters, not numbers

Give every amount and date as a **string, exactly as printed**, including grouping, symbols
and anything written beside them. Write 1,20,000.00 as "1,20,000.00" — do not convert it, do
not strip the commas, do not turn it into 120000. If the date reads 14/04/26, write
"14/04/26".

The system parses these itself and already knows about lakh grouping, currency symbols and
date orders. Your job is to see the characters correctly, and to point at the right ones.
That is the whole job.

Never reconstruct a figure you cannot see. If the total is cut off, obscured, or too faint
to read, report null rather than working it out from the line items. A figure you inferred
looks exactly like a figure you read, and the business owner cannot tell them apart.

## What counts as an invoice

Say IS_INVOICE when the document records a charge to the reader's business and shows what
was paid or is payable. Invoices, tax invoices, bills, receipts, and payment receipts all
count. A document does not have to be labelled "invoice", and a receipt for a completed
payment is just as useful to this system as a bill that is still owed.

Say IS_NOT_INVOICE when you can see it is something else: a delivery note or packing slip
with no prices, a quotation or estimate for work not yet done, a statement of account
listing many transactions, a purchase order, a contract, marketing material, a bank
statement, or a personal document that wandered in.

Say UNCERTAIN when you genuinely cannot tell. Some real cases:

- The document is too damaged, dark or blurred to read the parts that would decide it.
- It shows an amount and a vendor but nothing that says whether it is a bill, a quote or a
  receipt.
- It is a screenshot of a payment app that may be a confirmation or may be a balance.
- It is in a language or format you cannot read confidently.

**UNCERTAIN is a real answer and the system handles it properly** — the document stays
stored and the owner is asked. It is always better than a confident wrong answer. Saying
IS_INVOICE about a quotation puts a charge in someone's accounts that never happened;
saying IS_NOT_INVOICE about a faint receipt quietly loses a real expense. Both are worse
than asking.

When you are UNCERTAIN, still report every field you could read. Uncertainty about what the
document is does not make the characters on it less legible.

## The total is the amount payable

Take the grand total — after tax, after discount, after shipping. Not the subtotal, not the
largest line item, not the amount of a part payment unless that is all the document shows.

If the document shows several candidate figures, the one you want is the one a person would
pay. On an Indian tax invoice that is usually the row labelled "Total", "Grand Total",
"Amount Payable" or "Invoice Value", below the tax breakdown.

Report tax as the total of all tax charged. Indian invoices frequently split it into CGST
and SGST, sometimes with IGST or a cess; if the document prints a combined total tax line,
report that, and if it does not, add the components and report the sum as printed with its
own grouping.

## Who issued it

The vendor is whoever is charging — the company whose letterhead it is, not the customer it
is addressed to. On most invoices the issuer is at the top and the recipient is below under
"Bill To" or "Buyer". Getting these the wrong way round attributes every expense to the
business itself.

Report the registered name and the trading name separately where the document shows both —
"ABC Foods Private Limited" and "ABC Foods". This is often the only place the two appear
together, and the system uses that to recognise the same vendor later on a bank statement
where it may be written as ABCFOODS or RAZORPAY*ABCFOODS.

Only report an alias the document actually shows. Do not invent abbreviations.

## Currency

Read it from the symbol or the words beside the total: ₹ or Rs. or INR is INR, $ may be USD
or SGD or AUD and the issuer's address usually settles it. If nothing on the document says,
report null — do not assume the currency from the language or from the country of the
address alone.

---

Everything you return is checked against a schema, parsed by code, and shown to the business
owner. Your reason is what they read, so write it as a sentence about their document —
"A tax invoice from ABC Foods for catering, dated 14 April" — not as a classification code.`,
};
