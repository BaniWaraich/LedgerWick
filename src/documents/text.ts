/**
 * Deciding how to read a supporting document, from the document.
 *
 * spec: docs/workflows/manual-invoice-upload.md §4
 * architecture: docs/architecture.md §8.1, §8.2
 *
 * `§4` fixes the order: "If machine-readable text is available, the system should extract
 * the text directly. If the PDF does not contain usable text, the system should use OCR."
 * Images always take the second path. `§8.1` gives the reason — text extraction from a text
 * PDF is deterministic, and a deterministic answer is cheaper and more predictable than
 * asking a model to look at a picture of one.
 *
 * As in `src/statements/source.ts`, the choice is made from the bytes and never from the
 * filename. An invoice arrives as a Gmail attachment or as a user's upload; both carry a
 * name and a MIME type that the sender chose, and neither knows whether the PDF inside is a
 * born-digital receipt or a photograph someone dropped into a PDF wrapper.
 *
 * The decision is a pure function of a few measurements so that it can be tested, argued
 * with, and changed on evidence rather than by feel.
 */

import type { ExtractPdfText } from "./contracts";

/** A document, ready to be understood. */
export type DocumentContent =
  /** Embedded text was there and was worth reading. */
  | { readonly path: "TEXT"; readonly text: string }
  /**
   * Nothing usable to read, so the document itself goes to the model.
   *
   * `docs/architecture.md §8.2` leaves the OCR provider deliberately unchosen, to be
   * selected empirically. This branch is the seam where that choice lands: today the bytes
   * go to a multimodal model, and swapping in a dedicated OCR engine changes what consumes
   * this value, not how the decision is made.
   */
  | { readonly path: "VISUAL"; readonly bytes: Uint8Array; readonly mediaType: string };

/** Every PDF begins with this, whatever it is called. */
const PDF_MAGIC = "%PDF-";

/**
 * The image types this system will hand to a model, recognised by their leading bytes.
 *
 * A short list of formats someone has thought about, in the spirit of
 * `src/money/currencies.ts`: a type that is not here is a gap to fill deliberately, with a
 * test, rather than a thing to guess at. A HEIC photograph straight off an iPhone is the
 * most likely next entry, and it is absent because nothing has yet checked that the model
 * accepts one.
 */
const IMAGE_SIGNATURES: readonly {
  readonly mediaType: string;
  readonly magic: readonly number[];
}[] = [
  { mediaType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mediaType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP — the four bytes at offset 8 are what distinguish it from a RIFF audio
  // container, so the check below has to look past the header rather than at a prefix.
  { mediaType: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
];

/**
 * How much text a page must carry before its text layer is worth reading.
 *
 * The same two-measurement instinct as `src/statements/source.ts`, with numbers that suit a
 * different document. A statement's transaction table produces hundreds of characters a
 * page; an invoice is one page with a letterhead, a handful of line items and a total, and
 * a perfectly good one can be shorter than the 200-character bar a statement has to clear.
 *
 * The failure this defends against is the same, though: banks and vendors both wrap scans
 * in PDFs that still carry a letterhead or a footer as real glyphs, and "has any text at
 * all" would send a photograph down the text path to be read as three words.
 *
 * A digit is required as well as a length, because an invoice that carries no number
 * carries no amount, no date and no invoice number — whatever those characters are, they
 * are not the document we came for.
 *
 * **These numbers are provisional.** They were chosen to be obviously below a real invoice
 * and obviously above a letterhead, and nothing has measured them yet, because
 * `fixtures/invoices/` is empty (BAN-150). Tuning them against the corpus is part of
 * earning the bar in `docs/extraction-acceptance.md`.
 */
const MINIMUM_CHARACTERS_PER_PAGE = 80;

/** Whether these bytes are a PDF, asked of the bytes rather than of the filename. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC;
}

/**
 * The image type these bytes actually are, or null if they are not an image we accept.
 *
 * Reads the signature rather than the declared MIME type for the reason given at the top:
 * the declared type is whatever the sender wrote. A `.png` that is really a JPEG would be
 * sent to the model under the wrong media type and rejected by it.
 */
export function imageMediaType(bytes: Uint8Array): string | null {
  for (const { mediaType, magic } of IMAGE_SIGNATURES) {
    if (magic.every((byte, index) => bytes[index] === byte)) {
      if (mediaType !== "image/webp") return mediaType;
      // RIFF alone is not enough; the format name sits at offset 8.
      const format = new TextDecoder().decode(bytes.subarray(8, 12));
      if (format === "WEBP") return mediaType;
    }
  }
  return null;
}

/**
 * Whether a PDF's text layer is worth reading, given what was found in it.
 *
 * Both measurements have to agree, as in `source.ts`. Length alone would be fooled by a
 * scan whose letterhead spreads over several lines; a digit alone would be fooled by a page
 * number.
 */
export function hasUsableText(measurements: {
  pages: number;
  characters: number;
  hasDigit: boolean;
}): boolean {
  if (measurements.pages === 0) return false;
  if (!measurements.hasDigit) return false;
  return measurements.characters / measurements.pages >= MINIMUM_CHARACTERS_PER_PAGE;
}

/**
 * Read a document into whichever form understanding needs, or decline to.
 *
 * Null is the `UNREADABLE` outcome and not an error: a file that is neither a PDF nor an
 * image we accept has nothing to be read from it, the document stays stored, and the user
 * may still link it by hand (`docs/state-machines.md §3`).
 */
export async function readDocumentContent(
  bytes: Uint8Array,
  extractPdfText: ExtractPdfText,
): Promise<DocumentContent | null> {
  const mediaType = imageMediaType(bytes);
  if (mediaType) return { path: "VISUAL", bytes, mediaType };

  if (!looksLikePdf(bytes)) return null;

  /*
   * A copy, because the visual branch below still needs these bytes.
   *
   * pdf.js takes ownership of the array it is handed and detaches the underlying buffer, so
   * after extraction the original reads as zero bytes. Feature D lost every scanned
   * statement to exactly this, with an error from the gateway that pointed at the gateway;
   * `src/statements/pdf-text.ts` records it. The same trap is here, for the same reason,
   * and is avoided the same way.
   */
  const { pages, items } = await extractPdfText(new Uint8Array(bytes));
  const text = items
    .map((page) => page.map((item) => item.text).join(" "))
    .join("\n")
    .trim();
  const characters = items.flat().reduce((total, item) => total + item.text.trim().length, 0);

  return hasUsableText({ pages, characters, hasDigit: /[0-9]/.test(text) })
    ? { path: "TEXT", text }
    : { path: "VISUAL", bytes, mediaType: "application/pdf" };
}
