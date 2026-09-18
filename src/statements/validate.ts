/**
 * Checking a statement against its own balances.
 *
 * spec: docs/workflows/upload-statement.md Step 5, §7, §8
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 * decision: docs/decisions/0009-mapping-returns-locators.md
 *
 * One equation:
 *
 *     opening + credits − debits = closing
 *
 * It is the only automated check the parse gets, and `0003` is careful about what that is
 * worth. It catches magnitude errors well — a swapped debit/credit mapping shifts the total
 * and shows up at once, which is exactly the failure structural inference could plausibly
 * produce. It is blind to two errors that cancel, to a corrupted date, and to a corrupted
 * description. So a `VALID` outcome means the numbers add up, not that the parse was right,
 * and nothing here should be read as saying more than that.
 *
 * All of it in `bigint`. The equation adds thousands of amounts together and then compares
 * for equality, which is the one arithmetic a float cannot be trusted with.
 */

import { readAmount } from "../money/amounts";
import type { Currency } from "../money/currencies";
import type { ColumnMapping } from "../ai/prompts/map-statement-columns.v1";
import type { ScannedStatement } from "../ai/prompts/read-scanned-statement.v1";
import { chainIsReliable, type BalanceChainAudit } from "./balance-chain";
import type { Grid } from "./csv";
import type { ParsedLine } from "./walk";

/** Where a balance came from. Recorded, because a discrepancy reads differently for each. */
type BalanceSource = "LOCATOR" | "BALANCE_COLUMN" | "STATED";

interface Balance {
  readonly minor: bigint | null;
  readonly source: BalanceSource | null;
}

export interface Balances {
  readonly opening: Balance;
  readonly closing: Balance;
}

const ABSENT: Balance = { minor: null, source: null };

/** What the statement's own lines add up to. */
export interface Totals {
  readonly credits: bigint;
  readonly debits: bigint;
}

export interface Validation {
  readonly outcome: "VALID" | "DISCREPANCY";
  /** `closing − (opening + credits − debits)`. Null when a balance was not available. */
  readonly differenceMinor: bigint | null;
  readonly totals: Totals;
}

/**
 * How far a statement is from reconciling: `closing − (opening + credits − debits)`.
 *
 * Exported because the summary screen needs the same number, and the row it reads holds all
 * four inputs. One implementation rather than two, since this is the one piece of arithmetic
 * the product cannot afford to have disagree with itself — and a stored fifth column that
 * has to agree with the other four is a column that can stop agreeing with them.
 *
 * Null when any end is missing, which is `DISCREPANCY` with nothing to report.
 */
export function difference(figures: {
  openingBalance: bigint | null;
  closingBalance: bigint | null;
  totalCredits: bigint | null;
  totalDebits: bigint | null;
}): bigint | null {
  const { openingBalance, closingBalance, totalCredits, totalDebits } = figures;
  if (
    openingBalance === null ||
    closingBalance === null ||
    totalCredits === null ||
    totalDebits === null
  ) {
    return null;
  }
  return closingBalance - (openingBalance + totalCredits - totalDebits);
}

export function totalsOf(lines: readonly ParsedLine[]): Totals {
  let credits = 0n;
  let debits = 0n;
  for (const line of lines) {
    if (line.direction === "CREDIT") credits += line.amountMinor;
    else debits += line.amountMinor;
  }
  return { credits, debits };
}

/**
 * The opening and closing balance of a statement parsed from a grid.
 *
 * `0009`'s order: the cells the mapping pointed at first, then the running balance column,
 * then nothing. Each end is resolved on its own — a statement may print a closing balance
 * under the table and leave the opening one to be derived.
 */
export function balancesFromGrid(
  grid: Grid,
  mapping: ColumnMapping,
  lines: readonly ParsedLine[],
  currency: Currency,
): Balances {
  const at = (cell: { row: number; column: number } | null): bigint | null => {
    if (!cell) return null;
    const text = grid[cell.row]?.[cell.column];
    if (text === undefined) return null;
    const amount = readAmount(text, currency, mapping.decimalSeparator);
    if (!amount) return null;
    return amount.marker === "DEBIT" || amount.sign === "NEGATIVE"
      ? -amount.minorUnits
      : amount.minorUnits;
  };

  const derived = fromBalanceColumn(lines);

  return {
    opening: pick(at(mapping.openingBalanceCell), "LOCATOR", derived.opening),
    closing: pick(at(mapping.closingBalanceCell), "LOCATOR", derived.closing),
  };
}

/**
 * The same, for a statement a model transcribed.
 *
 * There are no locators on this path — there is no grid to point into — so a stated balance
 * is a figure the model read, marked `STATED` to say so. That distinction matters: on this
 * path a mismatch means the values may be wrong, and `§8` forbids retrying it into
 * acceptance.
 */
export function balancesFromScanned(
  statement: ScannedStatement,
  lines: readonly ParsedLine[],
  currency: Currency,
): Balances {
  const stated = (text: string | null): bigint | null => {
    if (text === null) return null;
    const amount = readAmount(text, currency, statement.decimalSeparator);
    if (!amount) return null;
    return amount.marker === "DEBIT" || amount.sign === "NEGATIVE"
      ? -amount.minorUnits
      : amount.minorUnits;
  };

  const derived = fromBalanceColumn(lines);

  return {
    opening: pick(stated(statement.openingBalance), "STATED", derived.opening),
    closing: pick(stated(statement.closingBalance), "STATED", derived.closing),
  };
}

function pick(preferred: bigint | null, source: BalanceSource, fallback: Balance): Balance {
  return preferred === null ? fallback : { minor: preferred, source };
}

/**
 * The two balances a running balance column implies.
 *
 * The closing balance is the last row that has one. The opening balance is the first row's
 * balance wound back past that row's own movement — the balance column records the position
 * *after* each transaction, so the figure before the first one is what the statement opened
 * at.
 */
function fromBalanceColumn(lines: readonly ParsedLine[]): Balances {
  if (lines.length === 0) return { opening: ABSENT, closing: ABSENT };

  /*
   * The first and last transactions specifically, not the first and last that happen to
   * have a balance.
   *
   * Those are different things, and the difference is a wrong number rather than a missing
   * one. On a sample statement whose final row printed its balance as `44.079.83` -- two
   * decimal points, so not a number at all -- this reached back to the previous row and
   * reported the statement as out by exactly the last transaction's amount. A confident
   * figure that is really "we used the wrong row" is worse than no figure: `§8` shows the
   * difference to the user as something to act on.
   */
  const first = lines[0];
  const last = lines[lines.length - 1];

  const before =
    first.balanceMinor === null
      ? null
      : first.direction === "DEBIT"
        ? first.balanceMinor + first.amountMinor
        : first.balanceMinor - first.amountMinor;

  return {
    opening: before === null ? ABSENT : { minor: before, source: "BALANCE_COLUMN" },
    closing:
      last.balanceMinor === null ? ABSENT : { minor: last.balanceMinor, source: "BALANCE_COLUMN" },
  };
}

/**
 * Whether the statement adds up.
 *
 * A statement with no opening or no closing balance is a `DISCREPANCY`, not a failure.
 * `§7` requires both for `VALID` and we do not have them; `§8` is explicit that a
 * discrepancy means the system does not trust the result rather than that processing
 * failed. `0009` reaches the same conclusion from the other direction.
 */
export function validate(
  lines: readonly ParsedLine[],
  balances: Balances,
  /*
   * The per-row check, where the statement printed enough balances to run one.
   *
   * Optional because a caller that has not computed it should not be forced to fake one, and
   * because an absent audit and an audit that found nothing are the same thing to the outcome.
   * They are not the same thing to the report, which says which it was.
   */
  audit?: BalanceChainAudit,
): Validation {
  const totals = totalsOf(lines);

  const differenceMinor = difference({
    openingBalance: balances.opening.minor,
    closingBalance: balances.closing.minor,
    totalCredits: totals.credits,
    totalDebits: totals.debits,
  });

  /*
   * A reconciling total is no longer enough on its own.
   *
   * The equation is the chain's telescoped sum, so it is blind to anything that cancels along
   * the way -- two errors in opposite directions, or a row the statement's own running balance
   * says moved no money while another absorbs the difference. `§7` asks whether the statement
   * adds up, and a document that contradicts itself row by row does not, however the ends
   * meet.
   *
   * Only a chain worth believing may demote an outcome. One that broke at nearly every link is
   * describing a mapping that put the balance somewhere else, and failing every such statement
   * on that basis would be reporting our own confusion as the document's.
   */
  const chainDisagrees = audit !== undefined && chainIsReliable(audit) && audit.breaks.length > 0;

  return {
    outcome: differenceMinor === 0n && !chainDisagrees ? "VALID" : "DISCREPANCY",
    differenceMinor,
    totals,
  };
}
