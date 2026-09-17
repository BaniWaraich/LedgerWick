import { describe, expect, it } from "vitest";

import { gridFromItems, type PositionedText } from "../../src/statements/pdf-grid";

function item(text: string, x: number, y: number, width: number): PositionedText {
  return { text, x, y, width };
}

/**
 * A page laid out the way a real statement is.
 *
 * The geometry is modelled on a text PDF of an HDFC current account: a left-aligned date, a
 * left-aligned narration, a left-aligned reference, and three right-aligned money columns.
 * The right-aligned ones are the point — their left edges move with the width of each
 * number, which is why grouping by left edge does not work.
 *
 * It has a realistic number of rows on purpose. Columns are recovered from agreement
 * between items, so a page with two transactions on it genuinely has less evidence of where
 * its columns are than a page with twenty. That is a property of the method, not something
 * to arrange around.
 */
const HEADER = [
  item("Date", 39.9, 900, 16),
  item("Narration", 152.7, 900, 34.2),
  item("Chq./Ref.No.", 292, 900, 44.7),
  item("Withdrawal Amt.", 405.3, 900, 60.5),
  item("Deposit Amt.", 491.1, 900, 44.8),
  item("Closing Balance", 564.3, 900, 54.9),
];

/** Money is right-aligned: the caller gives the right edge, and the left follows the width. */
function money(amount: string, right: number, y: number): PositionedText {
  const width = amount.length * 3.6;
  return item(amount, right - width, y, width);
}

const WITHDRAWAL_RIGHT = 470.2;
const DEPOSIT_RIGHT = 548.2;
const BALANCE_RIGHT = 626.7;

function transaction(
  y: number,
  narration: string,
  reference: string,
  debit: string | null,
  credit: string | null,
  balance: string,
): PositionedText[] {
  return [
    item("03/06/18", 33.7, y, 28.4),
    item(narration, 72, y, narration.length * 4.4),
    item(reference, 288.6, y, 64),
    ...(debit ? [money(debit, WITHDRAWAL_RIGHT, y)] : []),
    ...(credit ? [money(credit, DEPOSIT_RIGHT, y)] : []),
    money(balance, BALANCE_RIGHT, y),
  ];
}

/** Amounts of deliberately different widths, so no column shares a left edge. */
const ROWS = [
  transaction(880, "IB BILLPAY DR-HDFCPE", "IB03111916969774", "1,285.98", null, "27,778.97"),
  transaction(870, "GM1TSA/MY0326/19", "0000806023180071", null, "14,955.00", "29,064.95"),
  transaction(860, "NEFT DR-UBIN0539686", "N155180555427618", "5,000.00", null, "22,778.97"),
  transaction(850, "UPI-303702011409044", "0000815518132372", null, "7,000.00", "29,778.97"),
  transaction(840, "EMI 4923306 CHQ", "000000000000000", "2,268.00", null, "27,510.97"),
  transaction(830, "SALARY CREDIT", "0000815619221888", null, "1,45,955.00", "1,73,465.97"),
  transaction(820, "ACH DR ADOBE SYSTEMS", "ACH24061800012345", "999.00", null, "1,72,466.97"),
  transaction(810, "INT CR", "0000000000000000", null, "412.50", "1,72,879.47"),
];

const PAGE = [...HEADER, ...ROWS.flat()];

function rows(pages: PositionedText[][]) {
  return gridFromItems(pages).map((row) => [...row]);
}

/** The column a value landed in, by finding it in its own row. */
function columnOf(grid: string[][], row: number, value: string): number {
  return grid[row].indexOf(value);
}

describe("recovering a table from a page of positioned text", () => {
  it("groups items that share a baseline into one row", () => {
    expect(rows([PAGE])).toHaveLength(1 + ROWS.length);
  });

  it("orders rows down the page", () => {
    // PDF coordinates grow upwards, so the largest y is the topmost row.
    const grid = rows([PAGE]);
    expect(grid[0][0]).toBe("Date");
    expect(grid[1]).toContain("1,285.98");
    expect(grid[2]).toContain("14,955.00");
  });

  it("gives the table a column for each field", () => {
    const grid = rows([PAGE]);
    expect(grid[0].length).toBeGreaterThanOrEqual(6);
  });

  it("keeps a right-aligned debit and credit in separate columns", () => {
    // The failure this module exists to prevent. Merge these two and every deposit is
    // presented as a withdrawal -- and the statement still balances, so nothing downstream
    // notices.
    const grid = rows([PAGE]);
    expect(columnOf(grid, 1, "1,285.98")).not.toBe(columnOf(grid, 2, "14,955.00"));
  });

  it("puts a column's values in one column although their left edges all differ", () => {
    // 999.00, 1,285.98 and 5,000.00 start in three different places and are one column only
    // because they end in the same place. Left-edge grouping would call them three.
    const grid = rows([PAGE]);
    const debit = columnOf(grid, 1, "1,285.98");
    expect(columnOf(grid, 3, "5,000.00")).toBe(debit);
    expect(columnOf(grid, 7, "999.00")).toBe(debit);
  });

  it("keeps the balance column together across amounts of very different widths", () => {
    const grid = rows([PAGE]);
    const balance = columnOf(grid, 1, "27,778.97");
    expect(columnOf(grid, 6, "1,73,465.97")).toBe(balance);
  });

  it("keeps the date, the narration and the reference apart", () => {
    const grid = rows([PAGE]);
    const date = columnOf(grid, 1, "03/06/18");
    const narration = columnOf(grid, 1, "IB BILLPAY DR-HDFCPE");
    const reference = columnOf(grid, 1, "IB03111916969774");

    expect(new Set([date, narration, reference]).size).toBe(3);
    expect(date).toBeLessThan(narration);
    expect(narration).toBeLessThan(reference);
  });

  it("joins two runs of text in one cell with a space", () => {
    const split = [
      item("03/06/18", 33.7, 800, 28.4),
      item("IB BILLPAY", 72, 800, 40),
      item("DR-HDFCPE", 115, 800, 40),
      money("50.00", BALANCE_RIGHT, 800),
    ];
    const grid = rows([[...PAGE, ...split]]);
    expect(grid[grid.length - 1]).toContain("IB BILLPAY DR-HDFCPE");
  });

  it("ignores runs that are only whitespace", () => {
    // A PDF is full of these: an exporter emits a wide blank run to pad between columns.
    const grid = rows([[...PAGE, item("      ", 250, 805, 38)]]);
    expect(grid).toHaveLength(1 + ROWS.length);
  });
});

describe("a statement that runs across pages", () => {
  it("reads every page into one sequence of rows", () => {
    const grid = rows([[...HEADER, ...ROWS.slice(0, 4).flat()], [...ROWS.slice(4).flat()]]);
    expect(grid).toHaveLength(1 + ROWS.length);
  });

  it("puts page two's table in the same columns as page one's", () => {
    // Columns are derived across the whole document rather than per page, so the walker can
    // read the table as one thing.
    const grid = rows([[...HEADER, ...ROWS.slice(0, 4).flat()], [...ROWS.slice(4).flat()]]);
    expect(columnOf(grid, 1, "27,778.97")).toBe(columnOf(grid, 6, "1,73,465.97"));
  });
});

describe("a PDF with no text layer", () => {
  it("produces no rows at all", () => {
    // Not an error: this is the measurement that sends a scanned statement down the vision
    // path, and ADR 0003 requires that choice to come from the document.
    expect(gridFromItems([[]])).toEqual([]);
    expect(gridFromItems([])).toEqual([]);
  });
});
