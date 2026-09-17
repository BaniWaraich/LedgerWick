import { describe, expect, it } from "vitest";

import {
  hasUsableText,
  looksLikePdf,
  readStatementSource,
  type ExtractPdfText,
} from "../../src/statements/source";
import type { PositionedText } from "../../src/statements/pdf-grid";

describe("recognising a PDF", () => {
  it("asks the bytes, not the filename", () => {
    // spec: upload-statement §4 — the choice is made from the document itself. A bank
    // portal that serves a scan as `statement.pdf` has told us nothing.
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n..."))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("Date,Description,Amount\n"))).toBe(false);
  });

  it("does not mistake a CSV that mentions a PDF for one", () => {
    expect(looksLikePdf(new TextEncoder().encode("note,see %PDF- attached"))).toBe(false);
  });

  it("survives a file too short to hold a signature", () => {
    expect(looksLikePdf(new Uint8Array())).toBe(false);
    expect(looksLikePdf(new TextEncoder().encode("%P"))).toBe(false);
  });
});

describe("deciding whether a PDF's text layer is usable", () => {
  it("accepts a statement with a real table in it", () => {
    expect(hasUsableText({ pages: 5, characters: 24_000, rows: 281 })).toBe(true);
  });

  it("rejects a scan with no text at all", () => {
    // The document in the fixture inbox that is genuinely a scan carries zero characters
    // and produces zero rows.
    expect(hasUsableText({ pages: 1, characters: 0, rows: 0 })).toBe(false);
  });

  it("rejects a scan that carries only a letterhead", () => {
    // The case that matters, and the reason "has any text at all" is the wrong test. Banks
    // wrap scans in PDFs that still carry a letterhead or a page number as real glyphs;
    // parsing that text layer yields a three-row table that reconciles against nothing.
    expect(hasUsableText({ pages: 6, characters: 400, rows: 12 })).toBe(false);
  });

  it("requires enough rows as well as enough characters", () => {
    // A page of prose has plenty of characters and no table.
    expect(hasUsableText({ pages: 1, characters: 5_000, rows: 2 })).toBe(false);
  });

  it("requires enough characters as well as enough rows", () => {
    expect(hasUsableText({ pages: 4, characters: 300, rows: 40 })).toBe(false);
  });

  it("measures per page rather than in total", () => {
    // 1,000 characters is a real statement on one page and a letterhead across twelve.
    expect(hasUsableText({ pages: 1, characters: 1_000, rows: 10 })).toBe(true);
    expect(hasUsableText({ pages: 12, characters: 1_000, rows: 10 })).toBe(false);
  });

  it("rejects a PDF with no pages", () => {
    expect(hasUsableText({ pages: 0, characters: 0, rows: 0 })).toBe(false);
  });
});

/** A PDF text layer, as `unpdf` would report one. */
function pdfText(pages: PositionedText[][]): ExtractPdfText {
  return async () => ({ pages: pages.length, items: pages });
}

/** One line of a table, laid out well enough to survive column recovery. */
function line(y: number, cells: string[]): PositionedText[] {
  return cells.map((text, index) => ({ text, x: 40 + index * 120, y, width: text.length * 4 }));
}

const PDF = new TextEncoder().encode("%PDF-1.7\n");

describe("routing a document to its path", () => {
  it("sends a CSV down the text path", async () => {
    const csv = new TextEncoder().encode("Date,Amount\n01/08/2023,4850.00");
    const source = await readStatementSource(csv, pdfText([]));

    expect(source.path).toBe("TEXT");
    if (source.path === "TEXT") expect(source.grid[0]).toEqual(["Date", "Amount"]);
  });

  it("sends a PDF with a real table down the text path", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      line(800 - index * 10, [
        "0" + ((index % 9) + 1) + "/08/2023",
        "A LONG ENOUGH NARRATION TO COUNT",
        "REF000000000" + index,
        "4,850.00",
        "1,27,778.97",
      ]),
    );
    const source = await readStatementSource(PDF, pdfText([rows.flat()]));

    expect(source.path).toBe("TEXT");
  });

  it("sends a PDF with no text layer down the scanned path", async () => {
    const source = await readStatementSource(PDF, pdfText([[]]));

    expect(source.path).toBe("SCANNED");
    // The bytes go on untouched: the vision path needs the pages themselves, not anything
    // recovered from them.
    if (source.path === "SCANNED") {
      expect(source.bytes).toBe(PDF);
      expect(source.pages).toBe(1);
    }
  });

  it("sends a scan with only a letterhead down the scanned path", async () => {
    const letterhead = [
      line(800, ["CENTRAL BANK OF INDIA"]),
      line(790, ["Statement of account"]),
      line(780, ["Page 1"]),
    ].flat();
    const source = await readStatementSource(PDF, pdfText([letterhead, [], [], [], [], []]));

    expect(source.path).toBe("SCANNED");
  });
});

/**
 * An extractor that consumes what it is given, as the real one does.
 *
 * pdf.js takes ownership of the array and detaches its buffer. Every other fake in this file
 * politely leaves its argument alone, which is exactly why they all passed while every
 * scanned statement in the real app failed.
 */
function detachingPdfText(pages: PositionedText[][]): ExtractPdfText {
  return async (bytes) => {
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return { pages: pages.length, items: pages };
  };
}

describe("a PDF extractor that consumes its input", () => {
  it("still leaves the scanned path a readable document", async () => {
    // The bug this pins: the bytes went to the text extractor, came back detached and empty,
    // and were then handed to the vision model, which was sent a zero-byte PDF. It failed
    // every scanned statement on every retry, with an error that named the gateway.
    const source = await readStatementSource(PDF, detachingPdfText([[]]));

    expect(source.path).toBe("SCANNED");
    if (source.path === "SCANNED") {
      expect(source.bytes.byteLength).toBe(PDF.byteLength);
      expect(source.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("does not detach the caller's own array", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nscanned");
    await readStatementSource(bytes, detachingPdfText([[]]));

    // A detached buffer reads as zero bytes, which is the observable symptom and does not
    // need `ArrayBuffer.detached` (ES2024) to assert.
    expect(bytes.byteLength).toBe(16);
  });

  it("still routes a text PDF to the text path", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      line(800 - index * 10, [
        "0" + ((index % 9) + 1) + "/08/2023",
        "A LONG ENOUGH NARRATION TO COUNT",
        "REF000000000" + index,
        "4,850.00",
        "1,27,778.97",
      ]),
    );
    const source = await readStatementSource(PDF, detachingPdfText([rows.flat()]));

    expect(source.path).toBe("TEXT");
  });
});
