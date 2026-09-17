/**
 * Turning what a model read off a scanned page into statement lines.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * The scanned path's counterpart to `walk.ts`, and deliberately the same shape: it produces
 * the same `ParsedLine`s and the same count of rows it refused, so everything downstream —
 * validation, promotion, coverage — is identical whichever path a statement took. The one
 * thing that must stay different is what happens to a balance mismatch, and that is
 * `validate.ts`'s business, not this file's.
 *
 * Every figure arriving here is a string the model transcribed, and every one of them is
 * parsed by `readAmount` and `readDate` — the same functions the deterministic path uses.
 * That is not tidiness. A model that returns `120000` for `1,20,000.00` has interpreted the
 * grouping; a model that returns the characters has not, and keeping the interpretation in
 * one place means lakh grouping and Dr/Cr markers are understood identically on both paths.
 */

import { readAmount } from "../money/amounts";
import type { Currency } from "../money/currencies";
import type { ScannedStatement } from "../ai/prompts/read-scanned-statement.v1";
import { readDate } from "./dates";
import type { ParsedLine, SkippedRow, Walk } from "./walk";

/**
 * Convert transcribed rows into statement lines.
 *
 * A row the model reported that does not yield a date and a non-zero amount is skipped and
 * counted, exactly as in the walk. Here it means something slightly different — the model
 * transcribed something it should not have, or transcribed it too poorly to read — but the
 * caller's interest is the same: how much of what was found could actually be used.
 */
export function linesFromScanned(statement: ScannedStatement, currency: Currency): Walk {
  const lines: ParsedLine[] = [];
  const skipped: SkippedRow[] = [];

  const amount = (text: string | null) =>
    text === null ? null : readAmount(text, currency, statement.decimalSeparator);

  statement.rows.forEach((row, index) => {
    const valueDate = readDate(row.date, statement.dateOrder);
    if (!valueDate) {
      skipped.push({ rowIndex: index, reason: "no date" });
      return;
    }

    const debit = amount(row.debit);
    const credit = amount(row.credit);
    const out = debit && debit.minorUnits !== 0n ? debit : null;
    const inward = credit && credit.minorUnits !== 0n ? credit : null;

    if (out && inward) {
      skipped.push({ rowIndex: index, reason: "both a debit and a credit" });
      return;
    }
    if (!out && !inward) {
      skipped.push({ rowIndex: index, reason: "no amount" });
      return;
    }

    const balance = amount(row.balance);

    lines.push({
      // The model's own ordering. There is no grid here to index into, and these rows still
      // need to be distinct and ordered: `statement_lines_row_idx` is unique per statement,
      // and the sequence is what a person compares against the page.
      rowIndex: index,
      valueDate,
      description: row.description.replace(/\s+/g, " ").trim(),
      amountMinor: (out ?? inward)!.minorUnits,
      direction: out ? "DEBIT" : "CREDIT",
      balanceMinor: balance
        ? balance.marker === "DEBIT" || balance.sign === "NEGATIVE"
          ? -balance.minorUnits
          : balance.minorUnits
        : null,
      externalReference: reference(row.reference),
    });
  });

  return { lines, skipped };
}

/** As in `walk.ts`: a column of zeros is a placeholder, not an identity. */
const EMPTY_REFERENCE = /^[\s0\-.,/\\]*$/;

function reference(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" || EMPTY_REFERENCE.test(trimmed) ? null : trimmed;
}
