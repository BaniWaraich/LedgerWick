/**
 * Walking every row of a statement with the mapping the model returned.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * "Code then walks the whole document using that mapping. Every amount, date and description
 * is read deterministically." This is that walk. It is pure, it reads values only through
 * `readAmount` and `readDate`, and it decides nothing the mapping has not already decided.
 *
 * ## Rows it refuses
 *
 * A statement is not only transactions. Between them sit repeated headers on each page,
 * page footers, carried-forward lines, totals, and the bank's own advertising. The walk has
 * no list of those — a list would be a per-bank parser by another name — so it applies one
 * test: a row is a transaction if it yields a date and a non-zero amount. Everything else is
 * skipped **and counted**.
 *
 * The counting is the point. A mapping that is subtly wrong does not throw; it produces a
 * walk in which almost every row fails that test, and a silent skip would turn that into a
 * statement with four transactions in it and no sign anything went wrong. `docs/decisions/0003`
 * is explicit that the balance check cannot be relied on to catch a dropped row, so the skip
 * count is evidence in its own right and is carried out of here for the caller to weigh.
 */

import { readAmount, type Amount } from "../money/amounts";
import type { Currency } from "../money/currencies";
import type { ColumnMapping } from "../ai/prompts/map-statement-columns.v1";
import type { Grid } from "./csv";
import { readDate, type IsoDate } from "./dates";

/** One transaction, as this statement recorded it. */
export interface ParsedLine {
  /** The row of the grid it came from. Stored, so a wrong line is traceable to the file. */
  readonly rowIndex: number;
  readonly valueDate: string;
  readonly description: string;
  /** Always positive. `direction` carries the sign, as `canonical_transactions` does. */
  readonly amountMinor: bigint;
  readonly direction: "DEBIT" | "CREDIT";
  /** The running balance after this row, where the file has one. Signed: an account can be overdrawn. */
  readonly balanceMinor: bigint | null;
  readonly externalReference: string | null;
}

/** A row that was not a transaction, and what was missing. */
export interface SkippedRow {
  readonly rowIndex: number;
  readonly reason: string;
}

export interface Walk {
  readonly lines: ParsedLine[];
  readonly skipped: SkippedRow[];
}

/**
 * A reference that identifies nothing.
 *
 * Banks fill an unused reference column with zeros rather than leaving it blank — HDFC
 * writes `000000000000000` on every row that had no cheque. Carrying that through would be
 * a serious bug rather than an untidy one: `canonical_transactions_reference_idx` makes a
 * reference identity on its own, so a hundred rows sharing one placeholder would collapse
 * into a single transaction, and Step 5a calls a false merge the failure that silently
 * destroys a real payment.
 */
const EMPTY_REFERENCE = /^[\s0\-.,/\\]*$/;

/**
 * How far from a transaction a stray line of text may sit and still belong to it.
 *
 * Two is enough for every layout seen so far — ICICI puts one narration line above its
 * amounts and one below — and small enough that a header block further up the page cannot
 * reach a transaction and attach itself to it.
 */
const MAX_CONTINUATION_DISTANCE = 2;

export function walkStatement(grid: Grid, mapping: ColumnMapping, currency: Currency): Walk {
  const skipped: SkippedRow[] = [];

  const cell = (row: number, column: number | null): string =>
    column === null ? "" : (grid[row]?.[column] ?? "");

  const amountAt = (row: number, column: number | null): Amount | null =>
    column === null ? null : readAmount(cell(row, column), currency, mapping.decimalSeparator);

  const descriptionOn = (row: number): string =>
    mapping.descriptionColumns
      .map((column) => cell(row, column).trim())
      .filter((part) => part !== "")
      .join(" ");

  /*
   * Pass one: the rows that are transactions.
   *
   * A transaction is a row carrying an amount. The date may be absent, because plenty of
   * statements print it only when it changes — Bank of Ireland writes it once a day, and
   * requiring one per row threw away 238 of its 335 payments, which is 71% of a statement
   * silently discarded. So the last date seen is carried forward, which is what a person
   * reading the page does.
   *
   * Carried forward only, never backward, and only from a row that was itself a
   * transaction: a date belongs to the rows beneath it, and nothing above it.
   */
  const anchors: { row: number; line: Omit<ParsedLine, "description"> }[] = [];
  let carried: IsoDate | null = null;

  for (let row = mapping.firstDataRow; row < grid.length; row += 1) {
    const movement = readMovement(mapping, amountAt, cell, row);
    if (typeof movement === "string") {
      skipped.push({ rowIndex: row, reason: movement });
      continue;
    }

    const printed = readDate(cell(row, mapping.dateColumn), mapping.dateOrder);
    const valueDate: IsoDate | null = printed ?? carried;
    if (!valueDate) {
      // An amount before any date at all. Nothing to attribute it to.
      skipped.push({ rowIndex: row, reason: "no date" });
      continue;
    }

    /*
     * A row leaning on a carried date has to say what it was for.
     *
     * Dropping the date requirement let in rows that merely contain a number: Bank of
     * Ireland repeats the account's IBAN in a page footer, and its eight-digit account
     * number landed in the column the mapping had called "credit", arriving as a €750
     * million receipt on every page. A printed date is its own evidence that a row belongs
     * to the table; a carried one is an assumption, so it is only made for a row that also
     * carries a narration -- which every real transaction on that statement does, and none
     * of the footers do.
     */
    if (!printed && descriptionOn(row) === "") {
      skipped.push({ rowIndex: row, reason: "no date and no description" });
      continue;
    }

    carried = valueDate;

    const balance = amountAt(row, mapping.balanceColumn);

    anchors.push({
      row,
      line: {
        rowIndex: row,
        valueDate,
        amountMinor: movement.amountMinor,
        direction: movement.direction,
        balanceMinor: balance ? signed(balance) : null,
        externalReference: reference(cell(row, mapping.referenceColumn)),
      },
    });
  }

  /*
   * Pass two: the description, gathered from the rows around each transaction.
   *
   * A narration is a cell, not a row, and on a real statement it is often taller than the
   * figures beside it. ICICI renders a transaction as three baselines — a line of narration,
   * then the date and amounts, then more narration — with the numbers centred against the
   * text. Reading the description off the amount's own row found one for 98 of 728
   * transactions and left the rest blank, which would leave invoice identification with
   * nothing to reason about.
   *
   * So a row that carries description text and nothing else joins the nearest transaction.
   * "Nothing else" is the guard that matters: a repeated column header has text in the date
   * and amount columns too, so it is not a continuation and is never absorbed into one.
   */
  const anchorRows = anchors.map((anchor) => anchor.row);
  const gathered = new Map<number, number[]>();

  for (let row = mapping.firstDataRow; row < grid.length; row += 1) {
    if (anchorRows.includes(row)) continue;
    if (descriptionOn(row) === "") continue;
    if (!isBareText(mapping, cell, amountAt, row)) continue;

    const nearest = nearestAnchor(anchorRows, row);
    if (nearest === null) continue;

    const rows = gathered.get(nearest);
    if (rows) rows.push(row);
    else gathered.set(nearest, [row]);
  }

  const lines = anchors.map((anchor) => ({
    ...anchor.line,
    description: [...(gathered.get(anchor.row) ?? []), anchor.row]
      .sort((a, b) => a - b)
      .map(descriptionOn)
      .filter((part) => part !== "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  }));

  return { lines, skipped };
}

interface Movement {
  readonly amountMinor: bigint;
  readonly direction: "DEBIT" | "CREDIT";
}

/** The amount and which way it went, or the reason this row is not a transaction. */
function readMovement(
  mapping: ColumnMapping,
  amountAt: (row: number, column: number | null) => Amount | null,
  cell: (row: number, column: number | null) => string,
  row: number,
): Movement | string {
  if (mapping.amountShape === "DEBIT_CREDIT") {
    const debit = nonZero(amountAt(row, mapping.debitColumn));
    const credit = nonZero(amountAt(row, mapping.creditColumn));

    // Both filled is not a transaction with two amounts; it is a sign that one of these
    // columns is something else — most often the running balance, which every row fills.
    if (debit && credit) return "both a debit and a credit";
    if (debit) return { amountMinor: debit.minorUnits, direction: "DEBIT" };
    if (credit) return { amountMinor: credit.minorUnits, direction: "CREDIT" };
    return "no amount";
  }

  const amount = nonZero(amountAt(row, mapping.amountColumn));
  if (!amount) return "no amount";

  // An indicator column says the direction outright. A signed column says it with a minus,
  // brackets, or a marker inside the amount cell itself, all of which `readAmount` reports.
  const indicated =
    mapping.amountShape === "AMOUNT_WITH_INDICATOR"
      ? readIndicator(cell(row, mapping.indicatorColumn))
      : null;

  const direction =
    indicated ??
    fromCell(amount) ??
    // An unsigned, unmarked value in a column whose whole job is to carry a sign. Read as
    // money in, which is what an unsigned number in a signed column means arithmetically.
    // If the mapping is wrong about this the balance check is what says so, and on the
    // deterministic paths a mismatch buys one re-derive.
    "CREDIT";

  return { amountMinor: amount.minorUnits, direction };
}

/**
 * The direction printed in a separate indicator column.
 *
 * Matched on the first letter, because the same column is written `Dr`, `DR`, `D`, `Debit`
 * and `Dr.` by different banks and occasionally by one bank on different pages. Nothing else
 * is accepted: an unrecognised indicator returns null and the amount cell gets its say
 * instead, which is a better answer than assuming a direction from a word we do not know.
 */
function readIndicator(text: string): "DEBIT" | "CREDIT" | null {
  const first = text.trim().charAt(0).toUpperCase();
  if (first === "D") return "DEBIT";
  if (first === "C") return "CREDIT";
  // Some statements use a bare sign in this column rather than a letter.
  if (first === "-") return "DEBIT";
  if (first === "+") return "CREDIT";
  return null;
}

/** The direction the amount cell carried in itself: a sign, brackets, or a Dr/Cr marker. */
function fromCell(amount: Amount): "DEBIT" | "CREDIT" | null {
  if (amount.marker) return amount.marker;
  if (amount.sign === "NEGATIVE") return "DEBIT";
  if (amount.sign === "POSITIVE") return "CREDIT";
  return null;
}

/** An amount that is actually there. A zero is a filled-in blank, not a movement. */
function nonZero(amount: Amount | null): Amount | null {
  return amount && amount.minorUnits !== 0n ? amount : null;
}

/**
 * Whether a row is text and only text in the columns that decide a transaction.
 *
 * The guard that stops a repeated column header, a totals line or a page footer being
 * absorbed into the transaction above it: all of those put something in the date or amount
 * columns, and a genuine continuation of a narration puts nothing anywhere but the
 * description.
 */
function isBareText(
  mapping: ColumnMapping,
  cell: (row: number, column: number | null) => string,
  amountAt: (row: number, column: number | null) => Amount | null,
  row: number,
): boolean {
  if (cell(row, mapping.dateColumn).trim() !== "") return false;
  for (const column of [
    mapping.debitColumn,
    mapping.creditColumn,
    mapping.amountColumn,
    mapping.balanceColumn,
  ]) {
    if (amountAt(row, column)) return false;
  }
  return true;
}

/**
 * The transaction a stray line of text belongs to: the closest one, by row.
 *
 * On a tie the transaction above wins, because a wrapped narration continues downward more
 * often than it begins above — and where a statement does put the first line above its
 * figures, as ICICI does, that line is strictly closer to its own transaction than to the
 * one before it, so the tie never arises.
 */
function nearestAnchor(anchorRows: readonly number[], row: number): number | null {
  let best: number | null = null;
  let distance = MAX_CONTINUATION_DISTANCE + 1;

  for (const anchor of anchorRows) {
    const gap = Math.abs(anchor - row);
    if (gap < distance || (gap === distance && anchor < row)) {
      if (gap <= MAX_CONTINUATION_DISTANCE) {
        best = anchor;
        distance = gap;
      }
    }
  }

  return best;
}

/** A balance, with its sign applied: an account can be overdrawn. */
function signed(amount: Amount): bigint {
  return fromCell(amount) === "DEBIT" ? -amount.minorUnits : amount.minorUnits;
}

/** A bank reference, or null where the column holds a placeholder rather than an identity. */
function reference(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" || EMPTY_REFERENCE.test(trimmed) ? null : trimmed;
}
