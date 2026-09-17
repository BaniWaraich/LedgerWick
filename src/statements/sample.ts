/**
 * What the model is shown of a statement.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * ADR 0003: "The model sees a representative sample once per file." This decides what
 * "representative" means, and the two choices in it are load-bearing.
 *
 * **Every cell is labelled with its own column index.** The obvious rendering is a table
 * and the obvious failure is that the model then has to count columns to answer — across
 * rows where most cells are empty, which is exactly when counting goes wrong. Since every
 * answer in the mapping is an index, an off-by-one is not a cosmetic error: it maps the
 * balance column as the deposit column and produces a statement of plausible wrong numbers.
 * Labelling each cell removes the counting entirely.
 *
 * **The sample is taken from both ends.** A window from the top alone shows the header and
 * the first transactions and misses the closing balance, which on many statements is printed
 * under the table — and `docs/decisions/0009` requires the model to point at it. So the
 * sample is the head and the tail, with what was left out stated plainly.
 *
 * Row indices are the real ones throughout. They have to be: a locator is a row index into
 * the whole grid, and a sample that renumbered its rows would return locators pointing at
 * the wrong place in the document.
 */

import type { Grid } from "./csv";

/** How many rows from the top. Enough to show a header block, a header row and a run of
 *  transactions wide enough to settle `dateOrder` from a day above the twelfth. */
const HEAD_ROWS = 45;

/** How many from the bottom, for a closing balance or a totals row printed under the table. */
const TAIL_ROWS = 15;

/** A cell longer than this is truncated; a description is identified by its shape, not its
 *  tail, and one very long narration should not crowd out a row. */
const MAX_CELL_LENGTH = 80;

export function renderSample(grid: Grid): string {
  const head = Math.min(HEAD_ROWS, grid.length);
  const tail = Math.max(head, grid.length - TAIL_ROWS);

  const lines: string[] = [];
  for (let row = 0; row < head; row += 1) lines.push(renderRow(grid, row));

  if (tail > head) {
    lines.push(`... rows ${head} to ${tail - 1} omitted (${tail - head} rows) ...`);
    for (let row = tail; row < grid.length; row += 1) lines.push(renderRow(grid, row));
  }

  const columns = grid.reduce((widest, row) => Math.max(widest, row.length), 0);

  return [
    `The statement has ${grid.length} rows and ${columns} columns.`,
    "",
    "Each line below is one row. Empty cells are not shown. Every cell is written as",
    'c<column index>="<contents>", so you never need to count columns.',
    "",
    ...lines,
  ].join("\n");
}

function renderRow(grid: Grid, row: number): string {
  const cells = grid[row]
    .map((cell, column) => ({ cell: cell.trim(), column }))
    .filter((entry) => entry.cell !== "")
    .map((entry) => `c${entry.column}=${JSON.stringify(truncate(entry.cell))}`);

  return cells.length === 0 ? `row ${row} | (empty)` : `row ${row} | ${cells.join(" | ")}`;
}

function truncate(cell: string): string {
  return cell.length <= MAX_CELL_LENGTH ? cell : `${cell.slice(0, MAX_CELL_LENGTH)}…`;
}
