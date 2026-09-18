/**
 * What a parse reports about itself.
 *
 * spec: docs/parsing-acceptance.md
 *
 * Statement #5 in the acceptance log produced 404 transactions and a plausible €8,000 gap,
 * and nothing about that output said whether a quarter of the year had been dropped. These
 * tests are about the fields that would have answered it.
 */

import { describe, expect, it } from "vitest";

import type { ColumnMapping } from "../../src/ai/prompts/map-statement-columns.v1";
import type { BalanceChainAudit } from "../../src/statements/balance-chain";
import { parseReport } from "../../src/statements/parse-report";
import type { Balances, Validation } from "../../src/statements/validate";
import type { ParsedLine, Walk } from "../../src/statements/walk";

const MAPPING: ColumnMapping = {
  headerRow: 0,
  firstDataRow: 1,
  dateColumn: 0,
  dateOrder: "DMY",
  descriptionColumns: [1],
  referenceColumn: null,
  balanceColumn: 5,
  amountShape: "DEBIT_CREDIT",
  debitColumn: 3,
  creditColumn: 4,
  amountColumn: null,
  indicatorColumn: null,
  decimalSeparator: ".",
  openingBalanceCell: null,
  closingBalanceCell: null,
};

function line(valueDate: string, rowIndex = 0): ParsedLine {
  return {
    rowIndex,
    valueDate,
    description: "ACME TRADING",
    amountMinor: 485000n,
    direction: "DEBIT",
    balanceMinor: 900000n,
    externalReference: null,
  };
}

const BALANCES: Balances = {
  opening: { minor: 1000000n, source: "BALANCE_COLUMN" },
  closing: { minor: 200000n, source: "LOCATOR" },
};

const VALID: Validation = {
  outcome: "VALID",
  differenceMinor: 0n,
  totals: { credits: 0n, debits: 800000n },
};

/** A statement whose every row agreed with the balance printed beside it. */
const CLEAN_CHAIN: BalanceChainAudit = { coverage: "FULL", checked: 2, breaks: [] };

function report(
  overrides: {
    grid?: { length: number } | null;
    mapping?: ColumnMapping | null;
    walk?: Partial<Walk>;
    balances?: Balances;
    validation?: Validation;
    audit?: BalanceChainAudit;
  } = {},
) {
  return parseReport({
    grid: overrides.grid === undefined ? { length: 500 } : overrides.grid,
    mapping: overrides.mapping === undefined ? MAPPING : overrides.mapping,
    walk: { lines: [], skipped: [], ...overrides.walk },
    balances: overrides.balances ?? BALANCES,
    validation: overrides.validation ?? VALID,
    excluded: null,
    audit: overrides.audit ?? CLEAN_CHAIN,
  });
}

describe("what the report says about the walk's starting line", () => {
  it("states how many rows were never visited", () => {
    const r = report({ mapping: { ...MAPPING, firstDataRow: 212 } });

    expect(r.firstDataRow).toBe(212);
    expect(r.rowsBeforeFirstDataRow).toBe(212);
    expect(r.gridRows).toBe(500);
  });

  it("states the grid it read, so a short grid is distinguishable from a late start", () => {
    // 404 lines out of 410 rows is a parse that read the document. 404 out of 900 is not, and
    // until this field existed the two were the same number on the screen.
    expect(report({ grid: { length: 410 } }).gridRows).toBe(410);
  });

  it("has no grid to report on the scanned path", () => {
    expect(report({ grid: null, mapping: null }).gridRows).toBeNull();
  });
});

describe("the dates the report gives", () => {
  it("takes them from the lines that were extracted", () => {
    const r = report({
      walk: { lines: [line("2026-06-30", 2), line("2026-04-01", 1), line("2026-09-18", 3)] },
    });

    expect(r.extracted.firstDate).toBe("2026-04-01");
    expect(r.extracted.lastDate).toBe("2026-09-18");
  });

  /*
   * The confusion that produced this whole investigation. The batch page showed a period of
   * December to September, which came from the identification step, while the extracted rows
   * began in April -- so the screen agreed with the document and disagreed with the database,
   * and nothing on it made that visible.
   */
  it("never reports the period the document declared", () => {
    const r = report({ walk: { lines: [line("2026-04-01"), line("2026-06-30")] } });

    expect(r.extracted.firstDate).toBe("2026-04-01");
    expect(r.extracted.firstDate).not.toBe("2025-12-01");
  });

  it("reports no dates when nothing was extracted", () => {
    const r = report();
    expect(r.extracted).toEqual({ firstDate: null, lastDate: null });
  });
});

describe("the skipped rows", () => {
  it("counts them by reason", () => {
    const r = report({
      walk: {
        skipped: [
          { rowIndex: 4, reason: "no amount" },
          { rowIndex: 9, reason: "no amount" },
          { rowIndex: 11, reason: "no date" },
        ],
      },
    });

    expect(r.skipped.total).toBe(3);
    expect(r.skipped.byReason).toEqual({ "no amount": 2, "no date": 1 });
  });

  it("keeps the histogram exact however many rows there were", () => {
    const skipped = Array.from({ length: 500 }, (_, index) => ({
      rowIndex: index,
      reason: index % 2 === 0 ? "no amount" : "no date",
    }));

    const r = report({ walk: { skipped } });

    const summed = Object.values(r.skipped.byReason).reduce((total, count) => total + count, 0);
    expect(summed).toBe(500);
    expect(r.skipped.total).toBe(500);
  });

  it("caps the row list and says that it did", () => {
    const skipped = Array.from({ length: 500 }, (_, index) => ({
      rowIndex: index,
      reason: "no amount",
    }));

    const r = report({ walk: { skipped } });

    expect(r.skipped.rows).toHaveLength(200);
    expect(r.skipped.truncated).toBe(true);
  });

  it("does not claim truncation when the list fits", () => {
    const r = report({ walk: { skipped: [{ rowIndex: 1, reason: "no date" }] } });
    expect(r.skipped.truncated).toBe(false);
  });
});

describe("the figures", () => {
  it("records where each balance came from", () => {
    const r = report();

    expect(r.opening).toEqual({ minor: "1000000", source: "BALANCE_COLUMN" });
    expect(r.closing).toEqual({ minor: "200000", source: "LOCATOR" });
  });

  it("carries bigints as strings, because JSON cannot hold them", () => {
    const r = report({
      validation: { ...VALID, outcome: "DISCREPANCY", differenceMinor: -800000n },
    });

    expect(r.differenceMinor).toBe("-800000");
    expect(JSON.parse(JSON.stringify(r)).differenceMinor).toBe("-800000");
  });

  it("reports a missing balance rather than inventing one", () => {
    const r = report({
      balances: { opening: { minor: null, source: null }, closing: BALANCES.closing },
      validation: { ...VALID, outcome: "DISCREPANCY", differenceMinor: null },
    });

    expect(r.opening).toEqual({ minor: null, source: null });
    expect(r.differenceMinor).toBeNull();
  });
});

describe("the balance chain", () => {
  it("reports coverage, so an unchecked statement is not mistaken for a clean one", () => {
    const r = report({ audit: { coverage: "NONE", checked: 0, breaks: [] } });

    expect(r.chain.coverage).toBe("NONE");
    expect(r.chain.breakCount).toBe(0);
  });

  it("counts the breaks by what kind they are", () => {
    const r = report({
      audit: {
        coverage: "FULL",
        checked: 400,
        breaks: [
          break_(61, "EXTRANEOUS_ROW"),
          break_(122, "EXTRANEOUS_ROW"),
          break_(183, "MISSING_ROW"),
        ],
      },
    });

    expect(r.chain.breakCount).toBe(3);
    expect(r.chain.byKind).toEqual({ EXTRANEOUS_ROW: 2, MISSING_ROW: 1 });
  });

  it("carries the row each break sits on, so the finding reaches the document", () => {
    const r = report({
      audit: { coverage: "FULL", checked: 400, breaks: [break_(61, "EXTRANEOUS_ROW")] },
    });

    expect(r.chain.breaks[0]).toMatchObject({ rowIndex: 61, kind: "EXTRANEOUS_ROW" });
  });

  it("writes its figures as strings, like every other bigint here", () => {
    const r = report({
      audit: { coverage: "FULL", checked: 1, breaks: [break_(61, "EXTRANEOUS_ROW")] },
    });

    expect(JSON.parse(JSON.stringify(r)).chain.breaks[0].deltaMinor).toBe("2500");
  });

  it("caps the break list and says that it did", () => {
    const breaks = Array.from({ length: 80 }, (_, index) => break_(index, "AMOUNT"));
    const r = report({ audit: { coverage: "FULL", checked: 400, breaks } });

    expect(r.chain.breaks).toHaveLength(50);
    expect(r.chain.truncated).toBe(true);
    // The count stays exact whatever the cap did to the list.
    expect(r.chain.breakCount).toBe(80);
  });
});

function break_(rowIndex: number, kind: "EXTRANEOUS_ROW" | "MISSING_ROW" | "AMOUNT") {
  return {
    rowIndex,
    lineIndex: rowIndex,
    expectedMinor: 6500n,
    printedMinor: 9000n,
    deltaMinor: 2500n,
    kind,
  } as const;
}
