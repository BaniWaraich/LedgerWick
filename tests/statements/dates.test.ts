import { describe, expect, it } from "vitest";

import { readDate } from "../../src/statements/dates";

describe("the ordering comes from the file, not the cell", () => {
  it("reads the same digits three ways, as the mapping says", () => {
    // spec: upload-statement §4. Both readings of 01/08/2023 are real dates, so there is
    // no malformed input to catch — which is exactly why the ordering is decided once per
    // file rather than per row.
    expect(readDate("01/08/2023", "DMY")).toBe("2023-08-01");
    expect(readDate("01/08/2023", "MDY")).toBe("2023-01-08");
    expect(readDate("2023/08/01", "YMD")).toBe("2023-08-01");
  });

  it("accepts every separator a statement puts between the parts", () => {
    expect(readDate("01-08-2023", "DMY")).toBe("2023-08-01");
    expect(readDate("01.08.2023", "DMY")).toBe("2023-08-01");
    expect(readDate("01 08 2023", "DMY")).toBe("2023-08-01");
  });

  it("reads an ISO date whatever the mapping says", () => {
    // A four-digit leading component cannot be a day or a month, so the file has already
    // answered the question the mapping exists to answer.
    expect(readDate("2024-01-04", "DMY")).toBe("2024-01-04");
    expect(readDate("2024-01-04", "MDY")).toBe("2024-01-04");
  });
});

describe("a month printed by name", () => {
  it("is read as that month whatever the mapping says", () => {
    expect(readDate("4-JAN-2024", "MDY")).toBe("2024-01-04");
    expect(readDate("04 Jan 2024", "MDY")).toBe("2024-01-04");
    expect(readDate("04 January 2024", "DMY")).toBe("2024-01-04");
  });

  it("is read wherever in the cell it appears", () => {
    expect(readDate("Jan 04, 2024", "DMY")).toBe("2024-01-04");
    expect(readDate("2024 Jan 04", "DMY")).toBe("2024-01-04");
  });

  it("is matched case-insensitively and in full or abbreviated", () => {
    expect(readDate("04 SEP 2024", "DMY")).toBe("2024-09-04");
    expect(readDate("04 september 2024", "DMY")).toBe("2024-09-04");
    expect(readDate("04 Sept 2024", "DMY")).toBe("2024-09-04");
  });
});

describe("a two-digit year", () => {
  it("is read as this century", () => {
    // sbi.pdf's first line is `01-08-23`. The assumption is explicit: a business uploading
    // its statements today is not uploading 1923.
    expect(readDate("01-08-23", "DMY")).toBe("2023-08-01");
    expect(readDate("04 Jan 24", "DMY")).toBe("2024-01-04");
  });

  it("does not depend on the day the test runs", () => {
    // A function that consults the clock cannot be pinned by a golden file.
    expect(readDate("01-08-23", "DMY")).toBe(readDate("01-08-23", "DMY"));
    expect(readDate("31-12-99", "DMY")).toBe("2099-12-31");
  });
});

describe("declining to read", () => {
  it("returns null for an empty cell", () => {
    expect(readDate("", "DMY")).toBeNull();
    expect(readDate("   ", "DMY")).toBeNull();
  });

  it("returns null for a column header", () => {
    // What keeps a repeated header out of the statement lines: the walker asks for a date,
    // does not get one, and skips the row.
    expect(readDate("Date", "DMY")).toBeNull();
    expect(readDate("Value Date", "DMY")).toBeNull();
    expect(readDate("Txn Date", "DMY")).toBeNull();
  });

  it("returns null for a description that landed here by mistake", () => {
    expect(readDate("UPI/ACME TRADING/4850", "DMY")).toBeNull();
    expect(readDate("Brought forward", "DMY")).toBeNull();
  });

  it("returns null for a day that does not exist", () => {
    // Well-formed and still not a date. Recording it would put a transaction in a month it
    // never happened in, and the balance equation would never notice.
    expect(readDate("31/04/2023", "DMY")).toBeNull();
    expect(readDate("32/01/2023", "DMY")).toBeNull();
    expect(readDate("13/01/2023", "MDY")).toBeNull();
  });

  it("gets February right in a leap year and wrong the rest of the time", () => {
    expect(readDate("29/02/2024", "DMY")).toBe("2024-02-29");
    expect(readDate("29/02/2023", "DMY")).toBeNull();
  });

  it("returns null when there are not three parts", () => {
    expect(readDate("08/2023", "DMY")).toBeNull();
    expect(readDate("2023", "YMD")).toBeNull();
    expect(readDate("01/08/2023/14", "DMY")).toBeNull();
  });
});

describe("a date cell with a time appended", () => {
  it("reads the date and drops the time", () => {
    expect(readDate("01/08/2023 14:32", "DMY")).toBe("2023-08-01");
    expect(readDate("01/08/2023 14:32:07", "DMY")).toBe("2023-08-01");
    expect(readDate("01/08/2023, 2:05 PM", "DMY")).toBe("2023-08-01");
  });
});

describe("a date that leaves the year to the header", () => {
  // Plenty of statements print the year once, in the period, and then write "1 February"
  // against every row. Without the period such a statement yields nothing at all, which is
  // what it did: a sample statement parsed zero of its thirteen transactions.
  const february = { start: "2019-02-01", end: "2019-03-01" };

  it("takes its year from the period the document declared", () => {
    expect(readDate("1 February", "DMY", february)).toBe("2019-02-01");
    expect(readDate("16 February", "DMY", february)).toBe("2019-02-16");
    expect(readDate("February 16", "MDY", february)).toBe("2019-02-16");
  });

  it("is refused when there is no period to take one from", () => {
    // Guessing the current year is exactly the invention ADR 0008 exists to prevent.
    expect(readDate("1 February", "DMY")).toBeNull();
  });

  it("crosses a new year within the period", () => {
    const christmas = { start: "2018-12-15", end: "2019-01-15" };
    expect(readDate("20 December", "DMY", christmas)).toBe("2018-12-20");
    expect(readDate("5 January", "DMY", christmas)).toBe("2019-01-05");
  });

  it("reads a line dated just outside the period rather than refusing it", () => {
    expect(readDate("3 March", "DMY", february)).toBe("2019-03-03");
  });

  it("refuses a two-part numeric date, which is genuinely ambiguous", () => {
    // 01/02 could be a day and a month either way round, or a month and a year.
    expect(readDate("01/02", "DMY", february)).toBeNull();
    expect(readDate("2019", "DMY", february)).toBeNull();
  });

  it("still refuses a day that does not exist", () => {
    expect(readDate("30 February", "DMY", february)).toBeNull();
  });
});
