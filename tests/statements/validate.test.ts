import { describe, expect, it } from "vitest";

import type { ColumnMapping } from "../../src/ai/prompts/map-statement-columns.v1";
import { currencyFor } from "../../src/money/currencies";
import {
  balancesFromGrid,
  balancesFromScanned,
  difference,
  totalsOf,
  validate,
  type Balances,
} from "../../src/statements/validate";
import type { ParsedLine } from "../../src/statements/walk";

const INR = currencyFor("INR")!;

function line(over: Partial<ParsedLine> = {}): ParsedLine {
  return {
    rowIndex: 0,
    valueDate: "2023-08-01",
    description: "ACME",
    amountMinor: 100n,
    direction: "DEBIT",
    balanceMinor: null,
    externalReference: null,
    ...over,
  };
}

function balances(openingMinor: bigint | null, closingMinor: bigint | null): Balances {
  return {
    opening: { minor: openingMinor, source: openingMinor === null ? null : "LOCATOR" },
    closing: { minor: closingMinor, source: closingMinor === null ? null : "LOCATOR" },
  };
}

describe("totals", () => {
  it("adds credits and debits separately", () => {
    const totals = totalsOf([
      line({ amountMinor: 485000n, direction: "DEBIT" }),
      line({ amountMinor: 5000000n, direction: "CREDIT" }),
      line({ amountMinor: 128598n, direction: "DEBIT" }),
    ]);
    expect(totals).toEqual({ credits: 5000000n, debits: 613598n });
  });

  it("stays exact over an amount a float would round", () => {
    // The equation adds thousands of these and then compares for equality, which is the one
    // arithmetic a float cannot be trusted with.
    const many = Array.from({ length: 1000 }, () => line({ amountMinor: 7n, direction: "CREDIT" }));
    expect(totalsOf(many).credits).toBe(7000n);
  });

  it("is zero over no lines", () => {
    expect(totalsOf([])).toEqual({ credits: 0n, debits: 0n });
  });
});

describe("the equation", () => {
  it("calls a statement that reconciles VALID", () => {
    // spec: upload-statement §7 — opening + credits − debits = closing
    const lines = [
      line({ amountMinor: 485000n, direction: "DEBIT" }),
      line({ amountMinor: 1000000n, direction: "CREDIT" }),
    ];
    const result = validate(lines, balances(12000000n, 12515000n));

    expect(result.outcome).toBe("VALID");
    expect(result.differenceMinor).toBe(0n);
  });

  it("reports how far out a statement that does not reconcile is", () => {
    const lines = [line({ amountMinor: 485000n, direction: "DEBIT" })];
    const result = validate(lines, balances(12000000n, 11765000n));

    expect(result.outcome).toBe("DISCREPANCY");
    // The statement says it closed 250.00 higher than its own rows account for, so a debit
    // of that size is missing from the parse. §8 shows the user the figure.
    expect(result.differenceMinor).toBe(250000n);
  });

  it("catches a swapped debit and credit mapping", () => {
    // The failure 0003 says this check is good at. Reading a withdrawal as a deposit shifts
    // the total by twice the amount, which is far too large to miss.
    const asDebit = [line({ amountMinor: 485000n, direction: "DEBIT" })];
    const asCredit = [line({ amountMinor: 485000n, direction: "CREDIT" })];
    const ends = balances(12000000n, 11515000n);

    expect(validate(asDebit, ends).outcome).toBe("VALID");
    expect(validate(asCredit, ends).differenceMinor).toBe(-970000n);
  });

  it("is blind to two errors that cancel", () => {
    // Stated plainly by 0003, and worth a test so nobody reads VALID as "the parse was
    // right". Both rows are wrong by 100 in opposite directions and it still balances.
    const wrong = [
      line({ amountMinor: 485100n, direction: "DEBIT" }),
      line({ amountMinor: 1000100n, direction: "CREDIT" }),
    ];
    expect(validate(wrong, balances(12000000n, 12515000n)).outcome).toBe("VALID");
  });

  it("is blind to a corrupted date", () => {
    const lines = [line({ valueDate: "1999-01-01", amountMinor: 485000n, direction: "DEBIT" })];
    expect(validate(lines, balances(12000000n, 11515000n)).outcome).toBe("VALID");
  });
});

describe("a statement missing an end", () => {
  it("is a discrepancy rather than a failure", () => {
    // §7 requires both balances for VALID and we do not have them. §8: a discrepancy means
    // the system does not trust the result, not that processing failed.
    expect(validate([line()], balances(12000000n, null)).outcome).toBe("DISCREPANCY");
    expect(validate([line()], balances(null, 12000000n)).outcome).toBe("DISCREPANCY");
  });

  it("reports no difference, because there is none to compute", () => {
    expect(validate([line()], balances(null, null)).differenceMinor).toBeNull();
  });
});

describe("where the balances come from", () => {
  const mapping = {
    decimalSeparator: ".",
    openingBalanceCell: null,
    closingBalanceCell: null,
  } as unknown as ColumnMapping;

  const withColumn = [
    line({ amountMinor: 485000n, direction: "DEBIT", balanceMinor: 11515000n }),
    line({ amountMinor: 1000000n, direction: "CREDIT", balanceMinor: 12515000n }),
  ];

  it("winds the first row's balance back past its own movement", () => {
    // The balance column records the position after each transaction, so the figure before
    // the first one is what the statement opened at.
    const result = balancesFromGrid([], mapping, withColumn, INR);
    expect(result.opening).toEqual({ minor: 12000000n, source: "BALANCE_COLUMN" });
    expect(result.closing).toEqual({ minor: 12515000n, source: "BALANCE_COLUMN" });
  });

  it("winds back a credit the other way", () => {
    const credit = [line({ amountMinor: 1000000n, direction: "CREDIT", balanceMinor: 13000000n })];
    expect(balancesFromGrid([], mapping, credit, INR).opening.minor).toBe(12000000n);
  });

  it("prefers the cells the mapping pointed at", () => {
    // docs/decisions/0009: locators first, then the running balance column, then nothing.
    const grid = [
      ["Opening Balance", "1,20,000.00"],
      ["Closing Balance", "1,87,450.00"],
    ];
    const located = {
      ...mapping,
      openingBalanceCell: { row: 0, column: 1 },
      closingBalanceCell: { row: 1, column: 1 },
    } as ColumnMapping;

    const result = balancesFromGrid(grid, located, withColumn, INR);
    expect(result.opening).toEqual({ minor: 12000000n, source: "LOCATOR" });
    expect(result.closing).toEqual({ minor: 18745000n, source: "LOCATOR" });
  });

  it("resolves each end on its own", () => {
    // A statement may print a closing balance under the table and leave the opening one to
    // be derived.
    const grid = [["Closing Balance", "1,87,450.00"]];
    const half = { ...mapping, closingBalanceCell: { row: 0, column: 1 } } as ColumnMapping;

    const result = balancesFromGrid(grid, half, withColumn, INR);
    expect(result.opening.source).toBe("BALANCE_COLUMN");
    expect(result.closing.source).toBe("LOCATOR");
  });

  it("falls back when a locator points at something that is not an amount", () => {
    // A wrong locator yields a cell that does not parse, which 0009 says is caught here.
    const grid = [["Opening Balance", "see overleaf"]];
    const wrong = { ...mapping, openingBalanceCell: { row: 0, column: 1 } } as ColumnMapping;

    expect(balancesFromGrid(grid, wrong, withColumn, INR).opening.source).toBe("BALANCE_COLUMN");
  });

  it("falls back when a locator points off the end of the grid", () => {
    const wrong = { ...mapping, closingBalanceCell: { row: 99, column: 9 } } as ColumnMapping;
    expect(balancesFromGrid([], wrong, withColumn, INR).closing.source).toBe("BALANCE_COLUMN");
  });

  it("has nothing to offer when there is no column and no locator", () => {
    expect(balancesFromGrid([], mapping, [line()], INR)).toEqual({
      opening: { minor: null, source: null },
      closing: { minor: null, source: null },
    });
  });

  it("reads an overdrawn balance as negative", () => {
    const grid = [["Closing Balance", "(1,200.00)"]];
    const located = { ...mapping, closingBalanceCell: { row: 0, column: 1 } } as ColumnMapping;
    expect(balancesFromGrid(grid, located, [line()], INR).closing.minor).toBe(-120000n);
  });
});

describe("balances on the scanned path", () => {
  const statement = {
    dateOrder: "DMY" as const,
    decimalSeparator: "." as const,
    openingBalance: "1,20,000.00",
    closingBalance: "1,87,450.00",
    rows: [],
  };

  it("marks a figure the model read as STATED", () => {
    // Not a locator: there is no grid to point into, and on this path a mismatch means the
    // values may be wrong, which §8 forbids retrying into acceptance.
    const result = balancesFromScanned(statement, [], INR);
    expect(result.opening).toEqual({ minor: 12000000n, source: "STATED" });
    expect(result.closing).toEqual({ minor: 18745000n, source: "STATED" });
  });

  it("falls back to the transcribed balance column", () => {
    const lines = [line({ amountMinor: 485000n, direction: "DEBIT", balanceMinor: 11515000n })];
    const bare = { ...statement, openingBalance: null, closingBalance: null };
    expect(balancesFromScanned(bare, lines, INR).closing.source).toBe("BALANCE_COLUMN");
  });

  it("falls back when the model transcribed something unreadable", () => {
    const unreadable = { ...statement, closingBalance: "1,87,4??.00" };
    const lines = [line({ amountMinor: 485000n, direction: "DEBIT", balanceMinor: 11515000n })];
    expect(balancesFromScanned(unreadable, lines, INR).closing.source).toBe("BALANCE_COLUMN");
  });
});

describe("the difference, shared with the summary screen", () => {
  it("is the same expression validation uses", () => {
    // One implementation rather than two. The summary screen reads the four figures off the
    // row and needs the same number, and this is the one piece of arithmetic the product
    // cannot afford to have disagree with itself.
    const lines = [line({ amountMinor: 485000n, direction: "DEBIT" })];
    const result = validate(lines, balances(12000000n, 11765000n));

    expect(
      difference({
        openingBalance: 12000000n,
        closingBalance: 11765000n,
        totalCredits: 0n,
        totalDebits: 485000n,
      }),
    ).toBe(result.differenceMinor);
  });

  it("is zero for a statement that reconciles", () => {
    expect(
      difference({
        openingBalance: 12000000n,
        closingBalance: 11515000n,
        totalCredits: 0n,
        totalDebits: 485000n,
      }),
    ).toBe(0n);
  });

  it("is null when any end is missing", () => {
    const figures = {
      openingBalance: 12000000n,
      closingBalance: 11515000n,
      totalCredits: 0n,
      totalDebits: 485000n,
    };
    expect(difference({ ...figures, openingBalance: null })).toBeNull();
    expect(difference({ ...figures, closingBalance: null })).toBeNull();
    expect(difference({ ...figures, totalCredits: null })).toBeNull();
    expect(difference({ ...figures, totalDebits: null })).toBeNull();
  });
});
