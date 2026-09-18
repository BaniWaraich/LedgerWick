/**
 * Checking every row against the running balance the statement prints beside it.
 *
 * spec: docs/workflows/upload-statement.md Step 5 · docs/parsing-acceptance.md
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * `validate.ts` asks whether `opening + credits − debits` reaches `closing`. That equation is
 * the telescoped sum of the chain below: undifference it and the same figures give a check
 * per row rather than one for the document. Same inputs, same arithmetic, same `bigint`.
 *
 * Nothing here is a new structural claim, so `0003` is untouched. The model still decides
 * which column holds the running balance; this only reads it, exactly as `walk.ts` reads
 * every other value. What it adds is the one thing the aggregate cannot give:
 *
 *   **The aggregate says the statement is wrong. The chain says which rows.**
 *
 * Statement #5 in the acceptance log is the case it was written for. It reported 404
 * transactions and a difference of €8,682.61 against an opening and closing balance that were
 * both correct, and there was no way to tell from the outside which of the 404 were real. The
 * answer turned out to be thirteen rows of per-transaction metadata — an exchange rate, an
 * original-currency amount — admitted as transactions of their own because they carried a
 * number in a column the mapping had named.
 *
 * It also closes a hole `validate.ts` admits to in its own prose: two errors that cancel are
 * invisible to a total and cannot hide from a chain.
 *
 * ## What it does not do
 *
 * It does not decide anything. It returns findings, and `walk.ts` acts on the one kind of
 * finding the document itself has settled beyond argument. Every other kind is reported and
 * left alone, because a chain that breaks for a reason this module cannot name is a reason to
 * go and read the statement, not a licence to start deleting payments.
 */

import type { ParsedLine } from "./walk";

/**
 * Above this share of broken links, the chain is not evidence about rows.
 *
 * A balance column that is not the balance column breaks at nearly every link, and the honest
 * reading of that is one finding about the mapping rather than three hundred about
 * transactions. Reporting it the other way round would bury the mapping error in noise and
 * would make this check the sort of thing people learn to scroll past — which is the argument
 * `transactionLikeRowsBefore` already makes for its own strictness.
 *
 * A half is a starting point and not a measurement. `docs/architecture.md §21` is explicit
 * that a threshold belongs to evaluation rather than to taste, so this is a placeholder until
 * the fixture corpus can say what a real statement's break rate looks like.
 */
const UNRELIABLE_BREAK_RATIO = 0.5;

/** What went wrong at one link, as far as the arithmetic can tell. */
export type BreakKind =
  /** Leaving this row out restores the chain. It is not a movement. */
  | "EXTRANEOUS_ROW"
  /** The balance moved by this amount the other way. A debit read as a credit, or the reverse. */
  | "DIRECTION"
  /** The balance moved, but not by this much. The chain picks up again afterwards. */
  | "AMOUNT"
  /** The balance moved further than this row accounts for, and nothing here explains the rest. */
  | "MISSING_ROW"
  | "UNEXPLAINED";

export interface ChainBreak {
  /** The grid row, so a finding is traceable to the document. */
  readonly rowIndex: number;
  /** Where it sits in the extracted lines, so a caller can act on it without searching. */
  readonly lineIndex: number;
  readonly expectedMinor: bigint;
  readonly printedMinor: bigint;
  /** `printed − expected`. For an extraneous row this is the amount it wrongly applied. */
  readonly deltaMinor: bigint;
  readonly kind: BreakKind;
}

/**
 * How much of the statement the chain could actually speak for.
 *
 * `NONE` is not a pass. A statement that prints no running balance has not been checked, and
 * saying so is the difference between "these rows are right" and "nothing here disagreed".
 */
export type ChainCoverage = "NONE" | "PARTIAL" | "FULL" | "UNRELIABLE";

export interface BalanceChainAudit {
  readonly coverage: ChainCoverage;
  /** Links tested. A link spans from one printed balance to the next, not one row. */
  readonly checked: number;
  readonly breaks: ChainBreak[];
}

/** The balance a line leaves behind, signed the way the account moved. */
function signed(line: ParsedLine): bigint {
  return line.direction === "CREDIT" ? line.amountMinor : -line.amountMinor;
}

/**
 * Check each printed balance against the one before it and the rows in between.
 *
 * The unit is a link rather than a row, and that is what makes this work on more than one
 * bank's layout. Plenty of statements print a balance once a day rather than once a
 * transaction — Bank of Ireland does, and `walk.ts` carries its dates forward for the same
 * reason — so the sum is taken across every row since the last printed balance. A statement
 * that prints one on every row simply makes every link one row long.
 *
 * `openingAnchor` is the statement's own opening balance, and only when the document stated
 * it: `balancesFromGrid` will otherwise have derived that figure from the first extracted line
 * by unwinding its own amount, and checking a line against a number computed from it proves
 * nothing. Where the anchor is real the first row is checkable, which matters because a
 * spurious row at the top of a statement is invisible to every other check we have.
 */
export function auditBalanceChain(
  lines: readonly ParsedLine[],
  openingAnchor: bigint | null,
): BalanceChainAudit {
  const breaks: ChainBreak[] = [];
  let checked = 0;

  let previous: bigint | null = openingAnchor;
  let since: ParsedLine[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    since.push(line);

    if (line.balanceMinor === null) continue;
    if (previous === null) {
      // The first printed balance with nothing before it to measure from. It becomes the
      // anchor for everything after it rather than a link of its own.
      previous = line.balanceMinor;
      since = [];
      continue;
    }

    checked += 1;

    const expected = since.reduce((running, row) => running + signed(row), previous);

    if (expected !== line.balanceMinor) {
      breaks.push({
        rowIndex: line.rowIndex,
        lineIndex,
        expectedMinor: expected,
        printedMinor: line.balanceMinor,
        deltaMinor: line.balanceMinor - expected,
        kind: classify(previous, since, line.balanceMinor),
      });
    }

    previous = line.balanceMinor;
    since = [];
  }

  return { coverage: coverageOf(lines, checked, breaks.length), checked, breaks };
}

/**
 * What the arithmetic can say about a break, tested in order of how sure it is.
 *
 * Each test either reconciles exactly or it does not; there is no closest fit and no
 * tolerance. A near miss is `UNEXPLAINED`, which is honest — the alternative is a classifier
 * that names a cause it cannot demonstrate, and a caller downstream acting on the name.
 */
function classify(previous: bigint, since: readonly ParsedLine[], printed: bigint): BreakKind {
  const total = since.reduce((running, row) => running + signed(row), 0n);
  const last = since[since.length - 1];

  // The row's amount applied the other way round reaches the printed balance. A debit column
  // read as a credit is the ordinary cause, and it is a mapping error rather than a row error.
  if (previous + total - signed(last) * 2n === printed) return "DIRECTION";

  // Leaving the row out reaches it. The statement is saying this row moved no money, which is
  // what a line of metadata inside a transaction looks like from here.
  if (previous + total - signed(last) === printed) return "EXTRANEOUS_ROW";

  /*
   * The balance moved further than these rows account for, in the same direction they moved.
   * Something the walk never admitted is missing from between the two printed balances --
   * which is the Bank of Ireland failure, and the one the aggregate check provably cannot see,
   * because a statement that drops rows still reconciles against a closing balance derived
   * from the rows that survived.
   */
  const shortfall = printed - (previous + total);
  if (total !== 0n && shortfall > 0n === total > 0n) return "MISSING_ROW";

  // The balance moved, but not by what this row claims. The row is real and its figure is not.
  if (printed !== previous) return "AMOUNT";

  return "UNEXPLAINED";
}

function coverageOf(lines: readonly ParsedLine[], checked: number, broken: number): ChainCoverage {
  if (checked === 0) return "NONE";
  if (broken / checked > UNRELIABLE_BREAK_RATIO) return "UNRELIABLE";

  // Every line carrying a balance was tested, so the chain speaks for the whole statement.
  // Anything less means rows sat between two printed balances and were only checked as a
  // group -- still worth having, and worth distinguishing from the stronger claim.
  const withBalance = lines.filter((line) => line.balanceMinor !== null).length;
  return withBalance === lines.length ? "FULL" : "PARTIAL";
}

/**
 * Whether this audit is strong enough to act on rather than merely report.
 *
 * Exported because two callers need the same answer and neither should re-derive it: the
 * outcome in `validate.ts`, and the demotion in `walk.ts`.
 */
export function chainIsReliable(audit: BalanceChainAudit): boolean {
  return audit.coverage === "FULL" || audit.coverage === "PARTIAL";
}
