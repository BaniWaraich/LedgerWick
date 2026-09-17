/**
 * Deciding how to read a statement, from the statement.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * ADR 0003 splits parsing into two paths with very different risk. On CSV and text PDF a
 * model maps columns and code reads every value, so a misread digit has to get past
 * deterministic code to exist. On a scanned page the model reads the values itself, with
 * nothing underneath it, and a balance mismatch there is never retried into acceptance.
 *
 * Which path a document takes is therefore not a detail, and `upload-statement.md §4` is
 * explicit about how to choose: *"The choice between paths is made from the document
 * itself — whether usable embedded text exists — not from the file extension."* A PDF named
 * `.pdf` may be a photograph of a page, and a scan may be wrapped in a PDF by a bank's own
 * portal. The extension knows none of that; the text layer does.
 *
 * The decision is a pure function of three measurements so that it can be tested, argued
 * with, and changed on evidence rather than by feel.
 */

import { readCsvGrid, type Grid } from "./csv";
import { gridFromItems } from "./pdf-grid";
import type { PdfText } from "./pdf-text";

/**
 * Pulling the text out of a PDF, as this module needs it.
 *
 * Injected rather than imported, for the reason `identify.ts` injects its model call: the
 * decision below is the part worth testing, and the real implementation reaches for a PDF
 * library behind `server-only`. `src/statements/pdf-text.ts` supplies the one that ships.
 */
export type ExtractPdfText = (bytes: Uint8Array) => Promise<PdfText>;

/** A statement, ready to parse. */
export type StatementSource =
  | { readonly path: "TEXT"; readonly grid: Grid }
  | { readonly path: "SCANNED"; readonly bytes: Uint8Array; readonly pages: number };

/** Every PDF begins with this, whatever it is called. */
const PDF_MAGIC = "%PDF-";

/**
 * How much text a page must carry before its text layer is worth parsing.
 *
 * A scanned statement is not always empty of text. Banks wrap scans in PDFs that still
 * carry a letterhead, a footer, or a page number as real glyphs, so "has any text at all"
 * would send a photograph down the deterministic path and produce a table of three rows
 * that reconciles against nothing.
 *
 * Two hundred characters a page is comfortably below what a statement's transaction table
 * produces and comfortably above a letterhead. The document in the fixture inbox that is
 * genuinely a scan carries zero.
 */
const MINIMUM_CHARACTERS_PER_PAGE = 200;

/** Below this, there is no table here whatever the character count says. */
const MINIMUM_ROWS = 3;

/**
 * Whether a PDF's text layer is usable, given what was found in it.
 *
 * Both measurements have to agree. Characters alone would be fooled by a page of prose with
 * no table on it; rows alone would be fooled by a scan whose letterhead happens to spread
 * over several lines.
 */
export function hasUsableText(measurements: {
  pages: number;
  characters: number;
  rows: number;
}): boolean {
  if (measurements.pages === 0) return false;
  if (measurements.rows < MINIMUM_ROWS) return false;
  return measurements.characters / measurements.pages >= MINIMUM_CHARACTERS_PER_PAGE;
}

/** Whether these bytes are a PDF, asked of the bytes rather than of the filename. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC;
}

/**
 * Read a statement into whichever form its path needs.
 *
 * A CSV is always text — it has no other reading. A PDF is measured and sent one way or the
 * other, and the scanned branch hands the bytes on untouched, because the vision path needs
 * the pages themselves rather than anything recovered from them.
 */
export async function readStatementSource(
  bytes: Uint8Array,
  extractPdfText: ExtractPdfText,
): Promise<StatementSource> {
  if (!looksLikePdf(bytes)) return { path: "TEXT", grid: readCsvGrid(bytes) };

  const { pages, items } = await extractPdfText(bytes);
  const grid = gridFromItems(items);
  const characters = items.flat().reduce((total, item) => total + item.text.trim().length, 0);

  return hasUsableText({ pages, characters, rows: grid.length })
    ? { path: "TEXT", grid }
    : { path: "SCANNED", bytes, pages };
}
