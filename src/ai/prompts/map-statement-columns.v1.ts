/**
 * Mapping a statement's columns: which column is which, and how to read what is in them.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 * decision: docs/decisions/0009-mapping-returns-locators.md
 *
 * This is the single structural claim ADR 0003 stakes the whole no-per-bank-parser design
 * on. The model sees a sample of the grid once; code then walks every row of the document
 * using what it says. The model never sees most of the rows and never reports a number that
 * reaches the database.
 *
 * Three fields here are not columns, and each exists because the alternative was a guess
 * made once per row instead of once per file:
 *
 * - `dateOrder`, because `01/08/2023` is two different dates and a cell cannot say which.
 *   A sample of forty rows almost always can: one day above the twelfth settles it.
 * - `decimalSeparator`, because `1.234` is a thousand in Mumbai and one and a bit in
 *   Frankfurt.
 * - `amountShape`, because the vocabulary in ADR 0003 — `date · description · debit ·
 *   credit · balance` — describes only one of the three layouts real statements use. A
 *   single signed amount column, and an amount column with a separate `Dr`/`Cr` indicator,
 *   are both common in India, and forcing either into a debit/credit pair means inventing
 *   a column that is not there.
 *
 * The two balance fields are cell coordinates rather than amounts. `0009` says why.
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

/** A position in the grid the model was shown. `0009`: a locator, never a number. */
const cell = z.object({
  row: z.number().int().min(0).describe("Row index, exactly as labelled in the sample."),
  column: z.number().int().min(0).describe("Column index, exactly as labelled in the sample."),
});

/**
 * How this file expresses the direction of a movement.
 *
 * Flat rather than a discriminated union: a union puts `anyOf` into the JSON schema, which
 * is the construct structured-output modes are least reliable at, and this is the one model
 * call the entire parse depends on. The combinations are enforced below instead, where a
 * violation is a validation failure and the statement fails rather than being guessed at.
 */
const amountShapeEnum = z.enum(["DEBIT_CREDIT", "SIGNED_AMOUNT", "AMOUNT_WITH_INDICATOR"]);

export const columnMappingSchema = z
  .object({
    headerRow: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Row index of the table's header row, or null if the table has no header."),
    firstDataRow: z
      .number()
      .int()
      .min(0)
      .describe("Row index of the first row that is an actual transaction."),

    dateColumn: z.number().int().min(0).describe("Column index holding each transaction's date."),
    dateOrder: z
      .enum(["DMY", "MDY", "YMD"])
      .describe(
        "The order of the parts of a numeric date in this file: DMY for 01/08/2023 meaning 1 August, MDY for 8 January, YMD for 2023-08-01.",
      ),

    descriptionColumns: z
      .array(z.number().int().min(0))
      .min(1)
      .describe(
        "Column indices holding the transaction description, in the order they should be joined. Usually one; give several only where the description is genuinely split across columns.",
      ),
    referenceColumn: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "Column index of a bank-supplied reference, UTR or cheque number that identifies the transaction. Null if there is none.",
      ),
    balanceColumn: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Column index of the running balance after each transaction. Null if absent."),

    amountShape: amountShapeEnum.describe(
      "How this file expresses direction. See the rules for choosing.",
    ),
    debitColumn: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("DEBIT_CREDIT only: the column of money leaving the account. Otherwise null."),
    creditColumn: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("DEBIT_CREDIT only: the column of money entering the account. Otherwise null."),
    amountColumn: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "SIGNED_AMOUNT and AMOUNT_WITH_INDICATOR only: the single column of amounts. Otherwise null.",
      ),
    indicatorColumn: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "AMOUNT_WITH_INDICATOR only: the column holding Dr/Cr or equivalent. Otherwise null.",
      ),

    decimalSeparator: z
      .enum([".", ","])
      .describe("The character separating whole units from fractions in this file's amounts."),

    openingBalanceCell: cell
      .nullable()
      .describe(
        "The cell containing the statement's opening balance, wherever it is printed. Null if the document does not print one.",
      ),
    closingBalanceCell: cell
      .nullable()
      .describe(
        "The cell containing the statement's closing balance. Null if the document does not print one.",
      ),
  })
  .superRefine((mapping, context) => {
    const require = (field: keyof typeof mapping, present: boolean) => {
      const value = mapping[field];
      if (present && value === null) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when amountShape is ${mapping.amountShape}`,
        });
      }
      if (!present && value !== null) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must be null when amountShape is ${mapping.amountShape}`,
        });
      }
    };

    const pair = mapping.amountShape === "DEBIT_CREDIT";
    require("debitColumn", pair);
    require("creditColumn", pair);
    require("amountColumn", !pair);
    require("indicatorColumn", mapping.amountShape === "AMOUNT_WITH_INDICATOR");
  });

export type ColumnMapping = z.infer<typeof columnMappingSchema>;

export const mapStatementColumnsPrompt: PromptDefinition = {
  id: "map-statement-columns",
  version: 1,
  system: `You read the structure of bank and credit card statements for a bookkeeping system
used by small businesses, most of them in India.

You are shown a sample of one statement, already arranged into a grid of rows and columns.
Every row is labelled with its index and every column with its own. Your entire job is to say
which column is which, and how the values in them should be read.

You are NOT being asked to read the transactions. Code reads every row using what you return
here, so a column named correctly is worth far more than any value you could report.

## Map by where the VALUES are, not where the header text is

This is the mistake that matters most, and the grid's layout invites it.

Money columns are right-aligned and their headers are left-aligned, so a header like
"Withdrawal Amt." often sits in the column to the LEFT of the figures it describes. If the
header row and the transaction rows disagree, **the transaction rows are right**. Find the
column the actual numbers are in and return that index.

Check your answer against several transaction rows before you give it, not against the
header.

## Which columns to find

- The date of each transaction.
- The description or narration. If it is genuinely split over more than one column, list
  them in reading order. A separate reference or cheque number is NOT part of the
  description — it has its own field.
- A bank reference, UTR, cheque number or transaction id, if the file has one.
- The running balance after each transaction, if the file has one.
- The amount, in whichever of the three shapes below this file uses.

## The three amount shapes

Choose by looking at the transaction rows.

**DEBIT_CREDIT** — two separate columns, and any given row has a figure in one of them and
nothing in the other. Headed things like "Withdrawal / Deposit", "Debit / Credit",
"Paid Out / Paid In". Return debitColumn and creditColumn.

**AMOUNT_WITH_INDICATOR** — one column of amounts, and a separate column saying which way
each one goes: "Dr"/"Cr", "D"/"C", "DR"/"CR". Common on Indian statements. Return
amountColumn and indicatorColumn.

**SIGNED_AMOUNT** — one column of amounts carrying its own direction, by a minus sign, by
brackets, or by a Dr/Cr printed inside the same cell. Return amountColumn.

If two columns both hold money but every row fills both, they are not a debit/credit pair —
one of them is the running balance.

## dateOrder

Look at the date column across as many rows as you can see. A day above 12 anywhere in it
settles the order outright: 25/08/2023 can only be DMY, 08/25/2023 can only be MDY.

If nothing in the sample exceeds 12, fall back to what the rest of the document suggests —
an Indian statement is almost always DMY — but look first. This single field decides every
date in the file.

## decimalSeparator

Which character separates the whole part from the fraction. Almost always "." on an Indian
statement, where grouping is by comma and often in lakhs: 1,20,000.00. A European statement
may write 1.234,56, where it is ",".

## The opening and closing balance

Return the CELL each one is in — a row index and a column index — not the number. Code reads
the cell.

Look for them wherever the document prints them: a summary block above the table, a total
row below it, a line like "Opening Balance 1,20,000.00". Point at the cell holding the
figure itself, not at the cell holding its label.

If the statement has a running balance column and prints no separate opening or closing
figure, return null for both — the system derives them from the column.

Count rows and columns carefully. A locator pointing at the wrong cell is worse than null,
because null has a correct fallback and a wrong cell does not announce itself.

## firstDataRow and headerRow

firstDataRow is the first row that is an actual transaction, not a title, not the header, not
a "brought forward" line. headerRow is where the column titles are, or null if the table has
none.

---

Everything you return is checked against the file by code that reads every row. A mapping
that does not fit is rejected and the statement fails, which is the correct outcome — it is
far better than a mapping that half fits and produces a table of plausible wrong numbers.`,
};
