/**
 * Reading a text-based PDF statement as a grid of cells.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * The counterpart to `csv.ts`, and much the harder half. A CSV states its own structure; a
 * PDF has none. What a PDF actually contains is a bag of short strings, each with a
 * position on the page, and the table a human sees is an arrangement that has to be
 * recovered before ADR 0003's rule — a model maps columns, code walks rows — can mean
 * anything at all. That recovery is this module, and it is deliberately deterministic: it
 * is geometry, which is exactly the kind of work `docs/architecture.md §8.1` says to keep
 * out of a model's hands.
 *
 * ## How rows and columns are recovered
 *
 * **Rows** are easy. Items sharing a baseline are one line, within a tolerance that has to
 * be smaller than the line spacing and larger than the jitter between fonts on one line.
 *
 * **Columns** are not, and the reason is worth writing down because the obvious approach
 * fails silently. Grouping items by their left edge works for text, which is
 * left-aligned — and breaks on every numeric column, which is right-aligned, so its left
 * edge moves with the width of each number. Grouping by overlap instead merges the whole
 * page into one column as soon as a single wide line of address text bridges two of them.
 *
 * What is stable is that a left-aligned column shares a left edge and a right-aligned
 * column shares a right edge. So both edges vote, an edge position supported by enough
 * items becomes a boundary, and a cell is assigned to a column by its **midpoint** — which
 * lands correctly whichever way the column is aligned. On a real HDFC statement this is
 * the difference between the withdrawal and deposit columns being separated and the two
 * being merged into one, which would present every deposit as a withdrawal and still
 * balance.
 *
 * ## What it does not do
 *
 * It does not decide which column is which — that is the model's single structural claim.
 * It does not read a value. And it does not know whether the header row sits in the same
 * column as the numbers beneath it: a wide left-aligned header like `Withdrawal Amt.` has
 * its midpoint to the left of the figures it describes, so the two can land in adjacent
 * columns. The mapping prompt is told to map by where the **values** are rather than where
 * the header text is, because that is the fact the walker depends on.
 */

import type { Grid } from "./csv";

/** One run of text and where it sits on the page. The shape `unpdf` reports. */
export interface PositionedText {
  readonly text: string;
  /** Left edge, in points from the left of the page. */
  readonly x: number;
  /** Baseline, in points from the bottom of the page — so larger is higher up. */
  readonly y: number;
  readonly width: number;
}

/**
 * How far apart two baselines can be and still be one line.
 *
 * Has to be under the line spacing of a dense statement (about 8.7pt on the HDFC fixture)
 * and over the jitter between two fonts on one line (about 2.3pt on the same page).
 */
const LINE_TOLERANCE = 3;

/** How far apart two edges can be and still be the same column boundary. */
const EDGE_TOLERANCE = 2;

/** The least share of lines that must agree on an edge before it becomes a boundary. */
const SUPPORT_RATIO = 0.08;

/**
 * Below this, a supported boundary is noise rather than a column.
 *
 * Two, not one: a single item at some position says nothing, but two items agreeing on an
 * edge is the whole evidence a column is built from. The ratio above governs a page with
 * many lines; this floor is what lets a statement with only a handful of transactions still
 * resolve its columns.
 */
const MINIMUM_SUPPORT = 2;

interface Line {
  readonly y: number;
  readonly items: PositionedText[];
}

/** Group one page's items into lines, top to bottom, each ordered left to right. */
function linesOf(items: readonly PositionedText[]): Line[] {
  const ordered = [...items].sort((a, b) => b.y - a.y);
  const lines: { y: number; items: PositionedText[] }[] = [];

  for (const item of ordered) {
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - item.y) <= LINE_TOLERANCE) current.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }

  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * The edge positions that enough items agree on.
 *
 * Positions within a tolerance of each other are one candidate, and a candidate carries the
 * votes of everything in it. What comes back is the weighted centre of each candidate that
 * cleared the threshold.
 */
function supportedEdges(positions: readonly number[], required: number): number[] {
  const votes = new Map<number, number>();
  for (const position of positions) {
    const bucket = Math.round(position);
    votes.set(bucket, (votes.get(bucket) ?? 0) + 1);
  }

  const buckets = [...votes.keys()].sort((a, b) => a - b);
  const candidates: { last: number; count: number; weighted: number }[] = [];

  for (const bucket of buckets) {
    const count = votes.get(bucket)!;
    const current = candidates[candidates.length - 1];
    if (current && bucket - current.last <= EDGE_TOLERANCE) {
      current.last = bucket;
      current.count += count;
      current.weighted += bucket * count;
    } else {
      candidates.push({ last: bucket, count, weighted: bucket * count });
    }
  }

  return candidates
    .filter((candidate) => candidate.count >= required)
    .map((candidate) => candidate.weighted / candidate.count);
}

/**
 * Where one column ends and the next begins, across the whole document.
 *
 * Computed over every page at once rather than per page, so that page two's table lands in
 * the same columns as page one's. A statement whose later pages are laid out differently is
 * not a case this handles, and the balance check is what catches it.
 *
 * A right edge is nudged past the glyph it belongs to, so that the item ending there falls
 * on the correct side of its own boundary.
 */
function columnBoundaries(lines: readonly Line[]): number[] {
  const items = lines.flatMap((line) => line.items);
  const required = Math.max(MINIMUM_SUPPORT, Math.ceil(lines.length * SUPPORT_RATIO));

  const lefts = supportedEdges(
    items.map((item) => item.x),
    required,
  );
  const rights = supportedEdges(
    items.map((item) => item.x + item.width),
    required,
  ).map((edge) => edge + 0.5);

  return [...new Set([...lefts, ...rights])].sort((a, b) => a - b);
}

/**
 * Turn positioned text into a grid.
 *
 * Pure, and separated from the PDF library on purpose: the geometry above is the part worth
 * testing, and a test for it should be a handful of coordinates rather than a binary.
 *
 * `pages` is one array of items per page, in page order. The rows of every page are
 * concatenated, because a statement's table runs across pages and the walker reads it as
 * one sequence.
 */
export function gridFromItems(pages: readonly (readonly PositionedText[])[]): Grid {
  const printing = pages.map((page) => page.filter((item) => item.text.trim() !== ""));
  const lines = printing.map(linesOf);
  const boundaries = columnBoundaries(lines.flat());

  const width = boundaries.length + 1;
  const rows = lines.flat().map((line) => {
    const cells = new Array<string>(width).fill("");
    for (const item of line.items) {
      const middle = item.x + item.width / 2;
      let column = 0;
      while (column < boundaries.length && middle >= boundaries[column]) column += 1;
      const text = item.text.trim();
      cells[column] = cells[column] === "" ? text : `${cells[column]} ${text}`;
    }
    return cells;
  });

  // A boundary that separates nothing leaves an empty column behind. Dropping those keeps
  // the sample the model is shown free of columns that exist only as an artefact of how the
  // page was typeset.
  const occupied = new Array<boolean>(width).fill(false);
  for (const row of rows) row.forEach((cell, index) => (occupied[index] ||= cell !== ""));

  return rows.map((row) => row.filter((_, index) => occupied[index]));
}
