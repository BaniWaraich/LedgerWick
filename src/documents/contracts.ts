/**
 * What document understanding needs from the rest of the system, as types.
 *
 * Separated for the reason `src/requirements/contracts.ts` and
 * `src/statements/parse-contracts.ts` give: the logic and its tests can then be imported
 * without pulling in a provider, a key, or `server-only`. The implementations live in
 * `reader.ts` and in `src/statements/pdf-text.ts`.
 */

import type { PdfText } from "../statements/pdf-text";

/**
 * Pulling the text out of a PDF, as this module needs it.
 *
 * Injected rather than imported, exactly as `src/statements/source.ts` injects it: the
 * decision made from the measurement is the part worth testing, and the real
 * implementation reaches for a PDF library behind `server-only`.
 *
 * Declared here rather than imported from `source.ts` so that nothing in `src/documents/`
 * depends on statement parsing. The two features share a library adapter, not a module.
 */
export type ExtractPdfText = (bytes: Uint8Array) => Promise<PdfText>;
