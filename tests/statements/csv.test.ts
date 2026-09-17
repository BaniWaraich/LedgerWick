import { describe, expect, it } from "vitest";

import { decodeCsv, readCsvGrid, sniffDelimiter } from "../../src/statements/csv";

/** A CSV as a browser would hand it over: bytes, not a string. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function grid(text: string) {
  return readCsvGrid(utf8(text)).map((row) => [...row]);
}

describe("reading a CSV into a grid", () => {
  it("reads rows and cells in file order", () => {
    expect(grid("Date,Description,Amount\n01/08/2023,ACME,4850.00")).toEqual([
      ["Date", "Description", "Amount"],
      ["01/08/2023", "ACME", "4850.00"],
    ]);
  });

  it("interprets nothing", () => {
    // The grid is deliberately dumb. The mapping decides which column is which, and
    // amounts.ts and dates.ts read the values.
    expect(grid("01/08/2023,4850.00")).toEqual([["01/08/2023", "4850.00"]]);
  });

  it("trims the padding an exporter leaves around a cell", () => {
    expect(grid("  01/08/2023 , ACME  ,  4850.00")).toEqual([["01/08/2023", "ACME", "4850.00"]]);
  });

  it("survives every line ending", () => {
    expect(grid("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(grid("a,b\rc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(grid("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not invent a row for a trailing newline", () => {
    expect(grid("a,b\nc,d\n")).toHaveLength(2);
  });

  it("reads the last row of a file that does not end in a newline", () => {
    expect(grid("a,b\nc,d")).toHaveLength(2);
  });
});

describe("quoting", () => {
  it("keeps a delimiter that is inside a quoted field", () => {
    expect(grid('01/08/2023,"ACME TRADING, MUMBAI",4850.00')).toEqual([
      ["01/08/2023", "ACME TRADING, MUMBAI", "4850.00"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(grid('a,"she said ""hi""",b')).toEqual([["a", 'she said "hi"', "b"]]);
  });

  it("keeps a newline that is inside a quoted field", () => {
    // How a wrapped description survives an export. It is one cell, not two rows.
    expect(grid('01/08/2023,"ACME TRADING\nMUMBAI",4850.00')).toEqual([
      ["01/08/2023", "ACME TRADING\nMUMBAI", "4850.00"],
    ]);
  });

  it("reads an empty quoted field as an empty cell", () => {
    expect(grid('a,"",b')).toEqual([["a", "", "b"]]);
  });
});

describe("the shape of the grid", () => {
  it("keeps an empty row rather than closing the gap", () => {
    // The column mapping refers to rows by index. Dropping the blank line between a header
    // block and the table would shift every row under it.
    expect(grid("HDFC Bank\n\nDate,Amount\n01/08/2023,4850.00")).toEqual([
      ["HDFC Bank", ""],
      ["", ""],
      ["Date", "Amount"],
      ["01/08/2023", "4850.00"],
    ]);
  });

  it("pads a short row so every column can be indexed", () => {
    // A line with no trailing balance is how most exporters write one. A caller asking for
    // column 2 should get an empty cell, not undefined.
    const rows = grid("a,b,c\nd,e");
    expect(rows[1]).toEqual(["d", "e", ""]);
    expect(rows[1][2]).toBe("");
  });
});

describe("the delimiter is sniffed, not assumed", () => {
  it("finds a semicolon file", () => {
    expect(sniffDelimiter("Date;Description;Amount\n01/08/2023;ACME;4850,00")).toBe(";");
    expect(grid("Date;Description;Amount\n01/08/2023;ACME;4850,00")).toEqual([
      ["Date", "Description", "Amount"],
      ["01/08/2023", "ACME", "4850,00"],
    ]);
  });

  it("finds a tab-separated file", () => {
    expect(sniffDelimiter("Date\tAmount\n01/08/2023\t4850.00")).toBe("\t");
  });

  it("does not count a delimiter that is inside quotes", () => {
    // A semicolon file whose descriptions are full of commas. Counting blindly would pick
    // the comma and read the whole table as one column.
    const text = 'Date;Description;Amount\n01/08/2023;"ACME, MUMBAI, IN";4850,00';
    expect(sniffDelimiter(text)).toBe(";");
  });

  it("falls back to the comma when nothing is delimited", () => {
    expect(sniffDelimiter("just one column\nand another line")).toBe(",");
  });
});

describe("encoding", () => {
  it("strips a UTF-8 byte-order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("Date,Amount")]);
    expect(readCsvGrid(bytes)[0][0]).toBe("Date");
  });

  it("reads the UTF-16LE that Excel on Windows writes", () => {
    // Not exotic: "Save as CSV" produces this often enough that assuming UTF-8 turns a real
    // statement into a column of null bytes.
    const text = "Date,Amount\n01/08/2023,4850.00";
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < text.length; i += 1) {
      utf16[2 + i * 2] = text.charCodeAt(i) & 0xff;
      utf16[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    expect(decodeCsv(utf16)).toBe(text);
    expect(readCsvGrid(utf16)).toEqual([
      ["Date", "Amount"],
      ["01/08/2023", "4850.00"],
    ]);
  });

  it("keeps a rupee sign intact", () => {
    expect(grid('Amount\n"₹ 4,850.00"')).toEqual([["Amount"], ["₹ 4,850.00"]]);
  });

  it("splits an unquoted grouped amount, because that is what the file says", () => {
    // Not a bug to work around here. A bare ₹ 4,850.00 in a comma-delimited file genuinely
    // is two fields, and exporters quote it for exactly that reason. Guessing that a comma
    // between digits is grouping rather than a delimiter would be this module deciding
    // what an amount looks like, which is amounts.ts's job and needs the file's separator
    // to answer. A file that really is written this way loses its column alignment, and
    // the balance check is what catches it.
    expect(grid("Amount\n₹ 4,850.00")).toEqual([
      ["Amount", ""],
      ["₹ 4", "850.00"],
    ]);
  });
});
