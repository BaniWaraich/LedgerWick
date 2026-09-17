/**
 * Putting a scanned statement in front of a vision model.
 *
 * The scanned path's counterpart to `column-mapper.ts`, kept apart from the parsing logic
 * for the same reason. The document itself goes up here, because on this path there is
 * nothing else to send — ADR 0003's whole point about scanned input is that no text exists
 * to reduce it to first.
 */

import "server-only";

import { inferStructure } from "../ai/model";
import {
  readScannedStatementPrompt,
  scannedStatementSchema,
} from "../ai/prompts/read-scanned-statement.v1";
import type { ReadScanned } from "./parse-contracts";

export const readScanned: ReadScanned = async (document) =>
  inferStructure({
    prompt: readScannedStatementPrompt,
    schema: scannedStatementSchema,
    content: [{ type: "file", data: document.bytes, mediaType: "application/pdf" }],
  });
