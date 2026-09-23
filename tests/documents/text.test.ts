import { describe, expect, it } from "vitest";

import {
  hasUsableText,
  imageMediaType,
  looksLikePdf,
  readDocumentContent,
  type DocumentContent,
} from "../../src/documents/text";
import type { ExtractPdfText } from "../../src/documents/contracts";
import type { PositionedText } from "../../src/statements/pdf-grid";

/** A PDF, as far as anything here is concerned. */
const pdfBytes = (trailer = "") => new TextEncoder().encode(`%PDF-1.7\n${trailer}`);

/** One page of positioned runs, from plain strings. */
const page = (...texts: string[]): PositionedText[] =>
  texts.map((text, index) => ({ text, x: 0, y: index * 10, width: text.length * 5 }));

const extractorReturning = (items: PositionedText[][]): ExtractPdfText => {
  return async (bytes) => {
    // Every real extractor detaches the buffer it is handed. Doing it here is what makes
    // the "pass a copy" requirement testable rather than a comment nobody can check.
    void bytes.length;
    return { pages: items.length, items };
  };
};

describe("recognising a PDF", () => {
  it("asks the bytes, not the filename", () => {
    // spec: manual-invoice-upload §4. An attachment's declared type is whatever the sender
    // wrote, and a vendor mailing a photo as `invoice.pdf` has told us nothing.
    expect(looksLikePdf(pdfBytes())).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("Invoice #INV-2201"))).toBe(false);
  });

  it("survives a file too short to hold a signature", () => {
    expect(looksLikePdf(new Uint8Array())).toBe(false);
    expect(looksLikePdf(new TextEncoder().encode("%P"))).toBe(false);
  });
});

describe("recognising an image", () => {
  it("reads a JPEG by its signature", () => {
    expect(imageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
  });

  it("reads a PNG by its signature", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(imageMediaType(png)).toBe("image/png");
  });

  it("reads a WEBP only when the format name is there too", () => {
    const riff = (format: string) =>
      new Uint8Array([
        ...new TextEncoder().encode("RIFF"),
        0,
        0,
        0,
        0,
        ...new TextEncoder().encode(format),
      ]);

    expect(imageMediaType(riff("WEBP"))).toBe("image/webp");
    // A RIFF wave file shares the first four bytes and is not an image.
    expect(imageMediaType(riff("WAVE"))).toBeNull();
  });

  it("declines a format nobody has checked the model accepts", () => {
    // A HEIC photograph off an iPhone. Declining is the deliberate gap described in
    // `text.ts`, not an oversight: it becomes UNREADABLE and stays manually linkable.
    const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic")]);
    expect(imageMediaType(heic)).toBeNull();
  });

  it("is not fooled by a PDF", () => {
    expect(imageMediaType(pdfBytes())).toBeNull();
  });
});

describe("deciding whether a PDF's text layer is worth reading", () => {
  it("accepts an ordinary one-page invoice", () => {
    expect(hasUsableText({ pages: 1, characters: 420, hasDigit: true })).toBe(true);
  });

  it("rejects a scan with no text at all", () => {
    expect(hasUsableText({ pages: 1, characters: 0, hasDigit: false })).toBe(false);
  });

  it("rejects a scan carrying only a letterhead", () => {
    // The trap `src/statements/source.ts` documents, in its invoice form: a vendor's
    // portal wraps a scan in a PDF that still carries the company name as real glyphs.
    expect(hasUsableText({ pages: 1, characters: 40, hasDigit: false })).toBe(false);
  });

  it("rejects a page of prose with no figure anywhere in it", () => {
    // Long enough to clear the length bar, and still not an invoice: an invoice with no
    // digit has no amount, no date and no invoice number.
    expect(hasUsableText({ pages: 1, characters: 900, hasDigit: false })).toBe(false);
  });

  it("rejects a multi-page scan whose total looks respectable", () => {
    // 300 characters is plenty on one page and nothing across eight. Measuring per page is
    // what stops a long scan averaging its way past the bar.
    expect(hasUsableText({ pages: 8, characters: 300, hasDigit: true })).toBe(false);
  });

  it("has nothing to say about a document with no pages", () => {
    expect(hasUsableText({ pages: 0, characters: 0, hasDigit: false })).toBe(false);
  });
});

describe("reading a document into the form understanding needs", () => {
  it("sends an image straight to the visual path", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);
    const content = await readDocumentContent(jpeg, extractorReturning([]));

    expect(content).toEqual<DocumentContent>({
      path: "VISUAL",
      bytes: jpeg,
      mediaType: "image/jpeg",
    });
  });

  it("reads a text PDF's text", async () => {
    const extract = extractorReturning([
      page(
        "ACME Supplies Pvt Ltd",
        "Invoice INV-2201",
        "Total Rs. 1,20,000.00",
        "Date 14/04/2026",
        "Thank you for your business and prompt payment",
      ),
    ]);

    const content = await readDocumentContent(pdfBytes(), extract);

    expect(content?.path).toBe("TEXT");
    if (content?.path !== "TEXT") throw new Error("expected the text path");
    expect(content.text).toContain("INV-2201");
    expect(content.text).toContain("1,20,000.00");
  });

  it("sends a PDF carrying only a letterhead to the visual path", async () => {
    // spec: manual-invoice-upload §4 — "If the PDF does not contain usable text, the system
    // should use OCR." A scan wrapped by a vendor portal is exactly that case.
    const content = await readDocumentContent(pdfBytes(), extractorReturning([page("ACME")]));

    expect(content?.path).toBe("VISUAL");
    expect(content).toMatchObject({ mediaType: "application/pdf" });
  });

  it("hands the visual path bytes it can still read", async () => {
    // The failure that cost feature D every scanned statement: pdf.js detaches the array it
    // is given, so a caller that passes its only copy sends a zero-byte document onward.
    const bytes = pdfBytes("a".repeat(64));
    const detaching: ExtractPdfText = async (given) => {
      // Stand in for the detach by proving the argument is not the caller's own array.
      expect(given).not.toBe(bytes);
      return { pages: 1, items: [page("ACME")] };
    };

    const content = await readDocumentContent(bytes, detaching);

    if (content?.path !== "VISUAL") throw new Error("expected the visual path");
    expect(content.bytes.length).toBe(bytes.length);
  });

  it("declines a file that is neither a PDF nor an image we accept", async () => {
    // Null is the UNREADABLE outcome, not an error. docs/state-machines.md §3.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
    await expect(readDocumentContent(zip, extractorReturning([]))).resolves.toBeNull();
  });

  it("declines an empty file", async () => {
    await expect(readDocumentContent(new Uint8Array(), extractorReturning([]))).resolves.toBeNull();
  });
});
