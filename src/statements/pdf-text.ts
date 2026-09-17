/**
 * Getting positioned text out of a PDF.
 *
 * The adapter over `unpdf`, kept to one small file for the reason `docs/architecture.md
 * §8.2` gives about OCR and `AGENTS.md §5` gives in general: the library is replaceable,
 * and nothing else in the system should have to know which one is in use. Everything that
 * decides anything lives in `pdf-grid.ts`, which takes coordinates and is pure.
 *
 * `unpdf` rather than `pdfjs-dist` directly because it is the same pdf.js with the worker
 * and canvas setup already resolved for a serverless runtime, which is where this runs.
 */

import "server-only";

import { extractTextItems } from "unpdf";

import type { PositionedText } from "./pdf-grid";

/** What a PDF turned out to contain. */
export interface PdfText {
  readonly pages: number;
  /** One array of positioned runs per page, in page order. */
  readonly items: PositionedText[][];
}

/**
 * Read a PDF's embedded text.
 *
 * Consumes the array it is given: pdf.js detaches the underlying buffer, so the argument
 * reads as zero bytes afterwards. `source.ts` passes a copy for that reason.
 *
 * A PDF with no text layer is not an error here — it comes back with pages and no items,
 * which is precisely the signal that decides the scanned path. ADR 0003 requires that
 * choice to be made from the document rather than from its extension, and this is the
 * measurement it is made from.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  const { totalPages, items } = await extractTextItems(bytes);

  return {
    pages: totalPages,
    items: items.map((page) =>
      page.map((item) => ({ text: item.str, x: item.x, y: item.y, width: item.width })),
    ),
  };
}
