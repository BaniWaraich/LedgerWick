/**
 * Putting a stored document in front of the model.
 *
 * Kept apart from `identify.ts` so the decision logic there has no dependency on a model,
 * a provider, or a key — which is what lets every branch of Step 3a be tested directly.
 *
 * ADR 0003 says the path is chosen from the document itself rather than from its
 * extension. That rule governs *parsing* in feature D, where the difference between
 * reading structure and reading values is the whole decision. Identification asks a much
 * smaller question — what does this document say about itself — so a PDF goes to the model
 * whole and a CSV goes as text, and neither needs a text-extraction layer that feature D
 * has yet to choose.
 */

import "server-only";

import { inferStructure } from "../ai/model";
import { identificationSchema, identifyStatementPrompt } from "../ai/prompts/identify-statement.v2";
import type { IdentifyDocument } from "./identify";

/**
 * How much of a CSV the model sees.
 *
 * A statement's bank, account and period are in its first rows; the transactions are not
 * the question here. Capping it also keeps a large file from becoming a large prompt.
 */
const CSV_HEAD_BYTES = 8_000;

export const identifyDocument: IdentifyDocument = async (document) => {
  const isPdf = document.mimeType === "application/pdf";

  return inferStructure({
    prompt: identifyStatementPrompt,
    schema: identificationSchema,
    content: isPdf
      ? [
          { type: "text", text: `Filename: ${document.filename}` },
          { type: "file", data: document.bytes, mediaType: "application/pdf" },
        ]
      : [
          {
            type: "text",
            text: `Filename: ${document.filename}\n\nFirst rows of the file:\n\n${new TextDecoder().decode(
              document.bytes.slice(0, CSV_HEAD_BYTES),
            )}`,
          },
        ],
  });
};
