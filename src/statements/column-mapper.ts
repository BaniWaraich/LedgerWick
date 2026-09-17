/**
 * Putting a statement's structure in front of the model.
 *
 * The counterpart to `document-identifier.ts`, and kept apart from the parsing logic for the
 * same reason: the code that decides what to do with a mapping should have no dependency on
 * a model, a provider or a key, so every branch of it can be tested directly.
 *
 * What goes up is a rendered sample of the grid and nothing else. The document's bytes do
 * not: by the time this runs, the file has already been reduced to rows and columns by
 * deterministic code, and sending the original as well would invite the model to read values
 * off it — the one thing ADR 0003 exists to prevent on this path.
 */

import "server-only";

import { inferStructure } from "../ai/model";
import {
  columnMappingSchema,
  mapStatementColumnsPrompt,
} from "../ai/prompts/map-statement-columns.v1";
import type { MapColumns } from "./parse-contracts";
import { renderSample } from "./sample";

export const mapColumns: MapColumns = async (request) =>
  inferStructure({
    prompt: mapStatementColumnsPrompt,
    schema: columnMappingSchema,
    content: [
      {
        type: "text",
        text: [
          renderSample(request.grid),
          "",
          ...(request.problem
            ? [
                "",
                "A previous mapping of this statement did not reconcile:",
                request.problem,
                "",
                "Look again, in particular at which columns the transaction values are in and",
                "at whether the amount shape is right. Return your best mapping.",
              ]
            : []),
        ].join("\n"),
      },
    ],
  });
