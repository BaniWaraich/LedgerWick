import { describe, expect, it } from "vitest";

import { columnMappingSchema } from "../../src/ai/prompts/map-statement-columns.v1";

/** A mapping of the shape most Indian statements have. */
const DEBIT_CREDIT = {
  headerRow: 1,
  firstDataRow: 2,
  dateColumn: 0,
  dateOrder: "DMY" as const,
  descriptionColumns: [1],
  referenceColumn: 2,
  balanceColumn: 5,
  amountShape: "DEBIT_CREDIT" as const,
  debitColumn: 3,
  creditColumn: 4,
  amountColumn: null,
  indicatorColumn: null,
  decimalSeparator: "." as const,
  openingBalanceCell: null,
  closingBalanceCell: null,
};

function parse(overrides: Record<string, unknown>) {
  return columnMappingSchema.safeParse({ ...DEBIT_CREDIT, ...overrides });
}

describe("the three amount shapes", () => {
  it("accepts a debit and credit pair", () => {
    expect(parse({}).success).toBe(true);
  });

  it("accepts a single signed amount column", () => {
    const result = parse({
      amountShape: "SIGNED_AMOUNT",
      debitColumn: null,
      creditColumn: null,
      amountColumn: 3,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an amount column with a separate Dr/Cr indicator", () => {
    // Common on Indian statements, and not expressible in ADR 0003's original vocabulary.
    const result = parse({
      amountShape: "AMOUNT_WITH_INDICATOR",
      debitColumn: null,
      creditColumn: null,
      amountColumn: 3,
      indicatorColumn: 4,
    });
    expect(result.success).toBe(true);
  });
});

describe("a mapping that does not fit its own shape", () => {
  // ADR 0003: a mapping that fails validation fails the statement; it is not guessed at.

  it("rejects a debit/credit pair with no credit column", () => {
    expect(parse({ creditColumn: null }).success).toBe(false);
  });

  it("rejects a debit/credit pair that also names a single amount column", () => {
    expect(parse({ amountColumn: 3 }).success).toBe(false);
  });

  it("rejects a signed amount with no amount column", () => {
    const result = parse({
      amountShape: "SIGNED_AMOUNT",
      debitColumn: null,
      creditColumn: null,
      amountColumn: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an indicator shape with no indicator column", () => {
    const result = parse({
      amountShape: "AMOUNT_WITH_INDICATOR",
      debitColumn: null,
      creditColumn: null,
      amountColumn: 3,
      indicatorColumn: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an indicator column on a shape that has no indicator", () => {
    expect(parse({ indicatorColumn: 4 }).success).toBe(false);
  });
});

describe("the fields that are not columns", () => {
  it("requires a date order", () => {
    expect(parse({ dateOrder: undefined }).success).toBe(false);
    expect(parse({ dateOrder: "DDMMYY" }).success).toBe(false);
  });

  it("requires a decimal separator it knows", () => {
    expect(parse({ decimalSeparator: " " }).success).toBe(false);
  });

  it("requires at least one description column", () => {
    expect(parse({ descriptionColumns: [] }).success).toBe(false);
  });

  it("allows a description split across several columns", () => {
    expect(parse({ descriptionColumns: [1, 2] }).success).toBe(true);
  });
});

describe("the balances are locators, not numbers", () => {
  it("accepts a cell coordinate", () => {
    // docs/decisions/0009 — code reads the cell, so a wrong locator fails visibly while a
    // wrong number does not.
    const result = parse({
      openingBalanceCell: { row: 3, column: 5 },
      closingBalanceCell: { row: 280, column: 5 },
    });
    expect(result.success).toBe(true);
  });

  it("refuses an amount where a locator belongs", () => {
    expect(parse({ closingBalanceCell: 187450 }).success).toBe(false);
    expect(parse({ closingBalanceCell: "1,87,450.00" }).success).toBe(false);
  });

  it("refuses a locator that is missing half of itself", () => {
    expect(parse({ closingBalanceCell: { row: 4 } }).success).toBe(false);
  });

  it("accepts null where the document prints no such figure", () => {
    expect(parse({ openingBalanceCell: null, closingBalanceCell: null }).success).toBe(true);
  });
});

describe("indices", () => {
  it("refuses a negative column", () => {
    expect(parse({ dateColumn: -1 }).success).toBe(false);
  });

  it("refuses a fractional row", () => {
    expect(parse({ firstDataRow: 2.5 }).success).toBe(false);
  });
});
