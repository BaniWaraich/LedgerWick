/**
 * Reading a scanned statement, where there is no text to walk.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * The one place in this system where a model reports numbers that reach the database, and
 * ADR 0003 permits it in as many words — and only here, because there is no embedded text
 * and therefore no deterministic layer to put underneath. The decision names what that
 * costs: "the model *is* reading actual values here. There is no deterministic layer
 * underneath to catch a misread digit."
 *
 * What follows from that is not a better prompt. It is the rule in `§8` that a balance
 * mismatch on this path is flagged for manual review and **never retried into acceptance**,
 * because no amount of retrying makes a misread digit correct. That rule lives in
 * `validate.ts` and `parse.ts`; this file only has to make the model's job as narrow as
 * possible.
 *
 * So the amounts come back as **strings, exactly as printed**, and `readAmount` parses them
 * with the same rules that parse every other amount in the system. A model asked for a
 * number has to decide what `1,20,000.00` means; a model asked for the characters it can see
 * does not, and the code that already knows about lakh grouping and Dr/Cr markers keeps
 * that knowledge in one place.
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

/** One row of the table, as printed. Every figure is a string, never a number. */
const scannedRow = z.object({
  date: z.string().describe("The transaction's date, exactly as printed on the page."),
  description: z.string().describe("The description or narration, as printed."),
  debit: z
    .string()
    .nullable()
    .describe("Money out, exactly as printed including any grouping. Null if this row has none."),
  credit: z
    .string()
    .nullable()
    .describe("Money in, exactly as printed. Null if this row has none."),
  balance: z
    .string()
    .nullable()
    .describe("The running balance after this row, as printed. Null if the statement has none."),
  reference: z
    .string()
    .nullable()
    .describe("A cheque number, UTR or transaction reference, as printed. Null if there is none."),
});

export const scannedStatementSchema = z.object({
  dateOrder: z
    .enum(["DMY", "MDY", "YMD"])
    .describe(
      "The order of the parts of a numeric date on this statement. A day above 12 anywhere settles it.",
    ),
  decimalSeparator: z
    .enum([".", ","])
    .describe("The character separating whole units from fractions in the amounts."),
  openingBalance: z
    .string()
    .nullable()
    .describe("The opening balance as printed, if the statement states one. Null otherwise."),
  closingBalance: z
    .string()
    .nullable()
    .describe("The closing balance as printed, if the statement states one. Null otherwise."),
  rows: z
    .array(scannedRow)
    .describe("Every transaction row on the statement, in the order printed."),
});

export type ScannedStatement = z.infer<typeof scannedStatementSchema>;

export const readScannedStatementPrompt: PromptDefinition = {
  id: "read-scanned-statement",
  version: 1,
  system: `You read scanned bank and credit card statements for a bookkeeping system used by
small businesses, most of them in India.

The document you are given is an image of a statement. It has no machine-readable text, so
you are reading the page directly. Everything you report goes into a business's accounts.

## Report characters, not numbers

Give every amount as a **string, exactly as printed on the page**, including grouping,
symbols and any Dr/Cr written beside it. Write 1,20,000.00 as "1,20,000.00" — do not convert
it, do not strip the commas, do not turn it into 120000.

The system parses these itself and already knows about lakh grouping, currency symbols and
Dr/Cr markers. Your job is to see the characters correctly. That is the whole job.

The same goes for dates: report them as printed. If the page says 01-08-23, write "01-08-23".

## Every row, in order

Report every transaction row on every page, in the order they appear. Do not summarise, do
not skip rows that look like repeats, and do not stop early. A statement's rows are a
sequence and a missing one is a missing payment.

Do NOT report rows that are not transactions: column headers repeated on each page, page
footers, "brought forward" or "carried forward" lines, subtotals, totals, or the bank's
advertising.

## Which column is which

Most statements separate money out from money in — "Withdrawal"/"Deposit",
"Debit"/"Credit", "Paid Out"/"Paid In". Put each figure in the right one and leave the other
null.

If the statement has a single amount column with a Dr/Cr marker, use that marker to decide:
Dr is money out, so it goes in debit; Cr is money in, so it goes in credit.

If the statement has a single amount column and a running balance, work out the direction
from whether the balance went down or up, and say so by which field you fill.

Getting this backwards turns a payment into income. Check a row or two against the running
balance before you commit to it.

## Opening and closing balance

Report them as printed if the statement states them, in a summary block or as the first and
last balance figures it labels as such. Null if it does not.

## Where you cannot read something

If a character is genuinely illegible, report what you can see rather than inventing a digit
that makes the row look reasonable. A row that does not parse is caught and shown to a
person. A confidently wrong digit is filed into a business's accounts and nobody notices.

This statement's totals are checked against its own balances afterwards. If they do not
agree, the statement is sent to a human for review rather than retried — so there is nothing
to gain from making the numbers look consistent.`,
};
