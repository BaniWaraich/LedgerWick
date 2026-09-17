/**
 * The model calls parsing depends on, as types.
 *
 * Separated so that `parse.ts` and everything it uses can be imported by a test without
 * pulling in a provider, a key, or `server-only`. The implementations live in
 * `column-mapper.ts` and `scanned-reader.ts`; `identify.ts` draws the same line with
 * `IdentifyDocument`.
 */

import type { Inference } from "../ai/model";
import type { ColumnMapping } from "../ai/prompts/map-statement-columns.v1";
import type { Grid } from "./csv";

/** Ask the model which column is which. ADR 0003's one structural claim. */
export type MapColumns = (request: {
  grid: Grid;
  /**
   * Why the previous attempt is being retried, when it is.
   *
   * ADR 0003 allows one re-derive on the deterministic paths, because a balance mismatch
   * there suggests the mapping may be wrong. Telling the model what did not add up is the
   * difference between a second attempt and the same attempt.
   */
  problem?: string;
}) => Promise<Inference<ColumnMapping>>;
