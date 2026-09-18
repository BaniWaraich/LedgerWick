/**
 * What one parse actually did, in a form a person can read afterwards.
 *
 * spec: docs/parsing-acceptance.md
 *
 * A parse reports a line count and a difference, and neither of those distinguishes "this is
 * what the document says" from "this is what we managed to read". Statement #5 in the
 * acceptance log is what this module exists for: 404 transactions and a plausible €8,000
 * gap, with no way to tell from the outside whether a quarter of the year had been dropped.
 * Bank of Ireland did the same thing earlier with 238 rows, which is why the log says in as
 * many words that "the balance check cannot be relied on to notice".
 *
 * The blind spot it is pointed at is `walkStatement`, which iterates from
 * `mapping.firstDataRow`. Rows above that line are never visited and never recorded as
 * skipped, so a truncated walk and a complete one leave identical evidence. The report
 * states `firstDataRow` and how many rows sit above it, which is the smallest thing that
 * makes the two distinguishable.
 *
 * ## Why this is both logged and stored
 *
 * They fail in opposite directions, so neither covers the other.
 *
 * `parseStatement` writes its results in one update at the very end, after the lines and the
 * promotion. A statement killed by the platform's function timeout — or failed down any of
 * the `fail()` branches — stores nothing at all, and that is precisely the parse whose walk
 * you most want to see. Only a log line survives it, for the same reason
 * `src/observability/timing.ts` gives about durations: the recording has to have already
 * happened.
 *
 * A statement that completed with a discrepancy is the opposite case. It is sitting in the
 * database being looked at, possibly days later, long after the log line has aged out of
 * retention. There the durable record is the one that answers the question.
 *
 * ## It never decides anything
 *
 * Nothing here changes an outcome, a mapping or a line. `docs/decisions/0003` makes
 * structure the model's answer and values the code's, and a report that quietly corrected a
 * mapping would be code deciding structure. `docs/parsing-acceptance.md` adds the sharper
 * reason: a statement gets one first impression, and a silent correction destroys the
 * evidence that the mapping was ever wrong.
 */

import type { ColumnMapping } from "../ai/prompts/map-statement-columns.v1";
import type { BalanceChainAudit, BreakKind, ChainCoverage } from "./balance-chain";
import type { Balances, Validation } from "./validate";
import type { SkippedRow, Walk } from "./walk";

/**
 * How many individual skipped rows are kept.
 *
 * A badly mapped statement can skip every row it has, and storing five thousand of them in a
 * JSON column on every upload would cost more than it explains. The histogram below is exact
 * regardless of this cap and is what the reasoning actually runs on; the individual rows are
 * for going and looking at the document, and the first two hundred are enough to do that.
 */
const MAX_SKIPPED_ROWS = 200;

/**
 * How many individual chain breaks are kept.
 *
 * Smaller than the skipped-row cap, because a break is read one at a time against the
 * document rather than scanned in bulk, and because a statement with more than fifty of them
 * has a mapping problem that the count already states more usefully than the list would.
 */
const MAX_CHAIN_BREAKS = 50;

/** Where a balance came from, as `validate.ts` reports it. */
type BalanceSource = Balances["opening"]["source"];

/** Rows above `firstDataRow` that look like transactions the walk never saw. */
export interface ExcludedRows {
  readonly count: number;
  readonly firstRow: number;
  readonly lastRow: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
}

export interface ParseReport {
  /** Null on the scanned path, which has no grid to count. */
  readonly gridRows: number | null;
  readonly headerRow: number | null;
  readonly firstDataRow: number | null;
  /** Rows the walk never visited because they precede `firstDataRow`. */
  readonly rowsBeforeFirstDataRow: number;
  readonly lines: number;
  readonly skipped: {
    readonly total: number;
    /** Exact for every skipped row, whatever the cap did to the list below. */
    readonly byReason: Record<string, number>;
    readonly rows: SkippedRow[];
    readonly truncated: boolean;
  };
  /** The span of what was extracted — never the period the document declared. */
  readonly extracted: { readonly firstDate: string | null; readonly lastDate: string | null };
  readonly opening: { readonly minor: string | null; readonly source: BalanceSource };
  readonly closing: { readonly minor: string | null; readonly source: BalanceSource };
  readonly differenceMinor: string | null;
  readonly outcome: Validation["outcome"];
  /** Filled on the text path only. Null means the check did not run, not that it found none. */
  readonly excluded: ExcludedRows | null;
  /** Each row against the balance printed beside it. `NONE` coverage is not a pass. */
  readonly chain: {
    readonly coverage: ChainCoverage;
    readonly checked: number;
    readonly breakCount: number;
    readonly byKind: Partial<Record<BreakKind, number>>;
    readonly breaks: {
      readonly rowIndex: number;
      readonly lineIndex: number;
      readonly kind: BreakKind;
      readonly expectedMinor: string;
      readonly printedMinor: string;
      readonly deltaMinor: string;
      /** The row the break points at, which is rarely the row it was noticed on. */
      readonly implicatesRow: number | null;
    }[];
    readonly truncated: boolean;
  };
}

/**
 * Assemble the report from what the parse already has.
 *
 * Everything here is read rather than recomputed. A report that did its own arithmetic could
 * disagree with the row it describes, and then there would be two answers to "did this
 * reconcile" — which is the objection `validate.ts` already makes about storing a fifth
 * balance column beside the four it derives from.
 */
export function parseReport(input: {
  grid: { length: number } | null;
  mapping: ColumnMapping | null;
  walk: Walk;
  balances: Balances;
  validation: Validation;
  excluded: ExcludedRows | null;
  audit: BalanceChainAudit;
}): ParseReport {
  const { grid, mapping, walk, balances, validation, excluded, audit } = input;

  const byKind: Partial<Record<BreakKind, number>> = {};
  for (const item of audit.breaks) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;

  const byReason: Record<string, number> = {};
  for (const row of walk.skipped) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;

  // Sorted, because the walk emits rows in grid order but a re-derive can produce a second
  // attempt whose lines start elsewhere, and a range is only readable if the ends are the ends.
  const dates = walk.lines.map((line) => line.valueDate).sort();

  return {
    gridRows: grid?.length ?? null,
    headerRow: mapping?.headerRow ?? null,
    firstDataRow: mapping?.firstDataRow ?? null,
    rowsBeforeFirstDataRow: mapping?.firstDataRow ?? 0,
    lines: walk.lines.length,
    skipped: {
      total: walk.skipped.length,
      byReason,
      rows: walk.skipped.slice(0, MAX_SKIPPED_ROWS),
      truncated: walk.skipped.length > MAX_SKIPPED_ROWS,
    },
    extracted: { firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null },
    opening: { minor: balances.opening.minor?.toString() ?? null, source: balances.opening.source },
    closing: { minor: balances.closing.minor?.toString() ?? null, source: balances.closing.source },
    differenceMinor: validation.differenceMinor?.toString() ?? null,
    outcome: validation.outcome,
    excluded,
    chain: {
      coverage: audit.coverage,
      checked: audit.checked,
      breakCount: audit.breaks.length,
      byKind,
      breaks: audit.breaks.slice(0, MAX_CHAIN_BREAKS).map((item) => ({
        rowIndex: item.rowIndex,
        lineIndex: item.lineIndex,
        kind: item.kind,
        expectedMinor: item.expectedMinor.toString(),
        printedMinor: item.printedMinor.toString(),
        deltaMinor: item.deltaMinor.toString(),
        implicatesRow: item.implicates?.rowIndex ?? null,
      })),
      truncated: audit.breaks.length > MAX_CHAIN_BREAKS,
    },
  };
}

/**
 * Put the report where a killed function still leaves it behind.
 *
 * One line, in the field format `src/observability/timing.ts` established, so that the whole
 * parse reads out of `vercel logs | grep` rather than out of a JSON blob nobody unpacks. The
 * skipped rows go on a second line and only when there are any, because that list is the one
 * part of this that is not a fixed size.
 */
export function logParseReport(statementId: string, report: ParseReport): void {
  const fields = [
    `statement=${statementId}`,
    `gridRows=${report.gridRows}`,
    `headerRow=${report.headerRow}`,
    `firstDataRow=${report.firstDataRow}`,
    `before=${report.rowsBeforeFirstDataRow}`,
    `lines=${report.lines}`,
    `skipped=${report.skipped.total}`,
    `first=${report.extracted.firstDate}`,
    `last=${report.extracted.lastDate}`,
    `opening=${report.opening.minor}/${report.opening.source}`,
    `closing=${report.closing.minor}/${report.closing.source}`,
    `diff=${report.differenceMinor}`,
    `outcome=${report.outcome}`,
    `excludedLike=${report.excluded?.count ?? "n/a"}`,
    `chain=${report.chain.coverage}`,
    `links=${report.chain.checked}`,
    `breaks=${report.chain.breakCount}`,
  ];

  console.log(`[parse] ${fields.join(" ")}`);

  if (report.skipped.total > 0) {
    const reasons = Object.entries(report.skipped.byReason)
      .map(([reason, count]) => `${count}x ${reason}`)
      .join(", ");
    const rows = report.skipped.rows.map((row) => row.rowIndex).join(",");
    console.log(
      `[parse] statement=${statementId} skippedBy="${reasons}" rows=${rows}${
        report.skipped.truncated ? ",…" : ""
      }`,
    );
  }

  if (report.chain.breakCount > 0) {
    const kinds = Object.entries(report.chain.byKind)
      .map(([kind, count]) => `${count}x ${kind}`)
      .join(", ");
    /*
     * The implicated row where there is one, and the delta always.
     *
     * The delta is what makes the list addable: thirteen extraneous rows should sum to the
     * difference the statement is out by, and a list that does not sum to it is describing
     * something else.
     */
    const rows = report.chain.breaks
      .map(
        (item) =>
          `${item.rowIndex}:${item.kind}` +
          `${item.implicatesRow === null ? "" : `->${item.implicatesRow}`}` +
          `(${item.deltaMinor})`,
      )
      .join(",");
    console.log(
      `[parse] statement=${statementId} brokeBy="${kinds}" at=${rows}` +
        `${report.chain.truncated ? ",…" : ""}`,
    );
  }

  if (report.excluded) {
    const { count, firstRow, lastRow, firstDate, lastDate } = report.excluded;
    console.log(
      `[parse] statement=${statementId} excludedLike=${count} rows=${firstRow}-${lastRow} ` +
        `dates=${firstDate}..${lastDate}`,
    );
  }
}
