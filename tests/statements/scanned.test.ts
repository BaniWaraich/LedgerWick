import { describe, expect, it } from "vitest";

import type { ScannedStatement } from "../../src/ai/prompts/read-scanned-statement.v1";
import { currencyFor } from "../../src/money/currencies";
import { linesFromScanned } from "../../src/statements/scanned";

const INR = currencyFor("INR")!;

function statement(rows: ScannedStatement["rows"], overrides: Partial<ScannedStatement> = {}) {
  return linesFromScanned(
    {
      dateOrder: "DMY",
      decimalSeparator: ".",
      openingBalance: null,
      closingBalance: null,
      rows,
      ...overrides,
    },
    INR,
  );
}

function row(over: Partial<ScannedStatement["rows"][number]>): ScannedStatement["rows"][number] {
  return {
    date: "01/08/2023",
    description: "ACME TRADING",
    debit: null,
    credit: null,
    balance: null,
    reference: null,
    ...over,
  };
}

describe("turning a transcribed page into statement lines", () => {
  it("parses the characters the model reported rather than trusting a number", () => {
    // The point of asking for strings: a model that returns 120000 for 1,20,000.00 has
    // interpreted the grouping. One that returns the characters has not, and the same
    // reader that handles lakh grouping everywhere else handles it here.
    const { lines } = statement([row({ debit: "1,20,000.00" })]);
    expect(lines[0].amountMinor).toBe(12000000n);
  });

  it("reads a debit and a credit", () => {
    const { lines } = statement([
      row({ debit: "4,850.00" }),
      row({ date: "02/08/2023", credit: "50,000.00" }),
    ]);
    expect(lines.map((line) => line.direction)).toEqual(["DEBIT", "CREDIT"]);
  });

  it("reads the date in the order the model reported for the page", () => {
    const { lines } = statement([row({ date: "01-08-23", debit: "1.00" })]);
    expect(lines[0].valueDate).toBe("2023-08-01");
  });

  it("reads a European page when the model says the comma is decimal", () => {
    const { lines } = statement([row({ debit: "1.234,56" })], { decimalSeparator: "," });
    expect(lines[0].amountMinor).toBe(123456n);
  });

  it("keeps the model's ordering as the row index", () => {
    // There is no grid to index into here, and the rows still have to be distinct and
    // ordered: statement_lines_row_idx is unique per statement.
    const { lines } = statement([
      row({ debit: "1.00" }),
      row({ date: "02/08/2023", debit: "2.00" }),
    ]);
    expect(lines.map((line) => line.rowIndex)).toEqual([0, 1]);
  });

  it("records an overdrawn balance as negative", () => {
    const { lines } = statement([row({ debit: "1.00", balance: "1,200.00 Dr" })]);
    expect(lines[0].balanceMinor).toBe(-120000n);
  });

  it("discards a reference that is only a placeholder", () => {
    const { lines } = statement([row({ debit: "1.00", reference: "000000000" })]);
    expect(lines[0].externalReference).toBeNull();
  });
});

describe("rows the model should not have reported", () => {
  it("skips and counts a row with no readable date", () => {
    const { lines, skipped } = statement([row({ date: "Brought forward", balance: "1,000.00" })]);
    expect(lines).toHaveLength(0);
    expect(skipped).toEqual([{ rowIndex: 0, reason: "no date" }]);
  });

  it("skips and counts a row with no amount", () => {
    const { lines, skipped } = statement([row({})]);
    expect(lines).toHaveLength(0);
    expect(skipped[0].reason).toBe("no amount");
  });

  it("skips a row reported with both a debit and a credit", () => {
    const { lines, skipped } = statement([row({ debit: "1.00", credit: "2.00" })]);
    expect(lines).toHaveLength(0);
    expect(skipped[0].reason).toBe("both a debit and a credit");
  });

  it("treats a zero as an empty column", () => {
    const { lines } = statement([row({ debit: "4,850.00", credit: "0.00" })]);
    expect(lines[0]).toMatchObject({ amountMinor: 485000n, direction: "DEBIT" });
  });

  it("produces the same shape of result as the deterministic walk", () => {
    // Everything downstream -- validation, promotion, coverage -- is identical whichever
    // path a statement took. Only the handling of a mismatch differs, and that is not here.
    const result = statement([row({ debit: "1.00" })]);
    expect(Object.keys(result).sort()).toEqual(["lines", "skipped"]);
  });
});

describe("a page the model could not read", () => {
  it("returns no lines rather than throwing", () => {
    expect(statement([])).toEqual({ lines: [], skipped: [] });
  });
});
