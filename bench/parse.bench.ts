/**
 * The parse bench: run the real pipeline over the real corpus, and write down what it did.
 *
 * ## Why this exists
 *
 * `docs/parsing-acceptance.md` says the only evidence for `0003`'s claim is how often the
 * system is wrong about a statement it has never seen — and statement #5 showed we could
 * not answer that, because "the parse produced no evidence to read". A parse reported a
 * line count and a difference, and neither distinguishes *this is what the document says*
 * from *this is what we managed to read*.
 *
 * This runs `source → grid → sample → mapping → walk → chain → validate` outside Next, over
 * the documents in `fixtures/statements/inbox/`, and dumps every intermediate to disk. It
 * is a microscope, not a test: nothing in here asserts, and a red run means the harness
 * broke, not that a statement failed.
 *
 * ## The mapping cache is the point
 *
 * `bench/out/<name>/mapping.json` is written on the first run and reused after. Two
 * reasons, and the second is the one that matters:
 *
 * - Iterating on the *walker* is then free and instant, with no model call and no spend.
 * - A cached mapping can be **edited by hand**. That is how you ask "is the mapping wrong,
 *   or is the walk wrong?" — the question that statement #5 left open — without changing a
 *   line of code. Set `firstDataRow` yourself, re-run, see what the walk does with it.
 *
 * `BENCH_REMAP=1` throws the cache away and asks the model again.
 *
 * ## Running it
 *
 *   npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts
 *   BENCH_ONLY=hdfc BENCH_REMAP=1 npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts
 *
 * Unredacted documents in, so `bench/out/` is git-ignored and stays that way.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";

import { generateObject } from "ai";
import { describe, it } from "vitest";

import {
  columnMappingSchema,
  mapStatementColumnsPrompt,
  type ColumnMapping,
} from "../src/ai/prompts/map-statement-columns.v1";
import { currencyFor, type Currency } from "../src/money/currencies";
import { auditBalanceChain } from "../src/statements/balance-chain";
import { type PositionedText } from "../src/statements/pdf-grid";
import { parseReport } from "../src/statements/parse-report";
import { renderSample } from "../src/statements/sample";
import { readStatementSource } from "../src/statements/source";
import { balancesFromGrid, validate } from "../src/statements/validate";
import { transactionLikeRowsBefore, walkStatement } from "../src/statements/walk";
import type { Grid } from "../src/statements/csv";

const INBOX = path.resolve(__dirname, "../fixtures/statements/inbox");
const OUT = path.resolve(__dirname, "out");

/**
 * The currency each document is held in.
 *
 * In the product this comes from the bound bank account (feature C). Offline there is no
 * account, and the currency decides how `readAmount` reads a cell, so it cannot be guessed.
 * Anything not named here is treated as INR, which is the corpus's default.
 */
const CURRENCIES: Record<string, string> = {
  "bank-of-ireland": "EUR",
};

/** `pdf-text.ts` behind `server-only`, reimplemented for a plain Node process. */
async function extractPdfText(bytes: Uint8Array) {
  const { extractTextItems } = await import("unpdf");
  const { totalPages, items } = await extractTextItems(bytes);
  return {
    pages: totalPages,
    items: items.map((page) =>
      page.map((item): PositionedText => ({
        text: item.str,
        x: item.x,
        y: item.y,
        width: item.width,
      })),
    ),
  };
}

/**
 * The mapping for this document: from disk if it is there, from the model otherwise.
 *
 * Deliberately not `src/ai/model.ts` — that module is `server-only` and cannot be imported
 * into a plain Node process. It is the same prompt and the same schema, called the same way,
 * which is what the bench needs to be measuring.
 */
async function mapping(name: string, grid: Grid, problem?: string): Promise<ColumnMapping | null> {
  const cached = path.join(OUT, name, "mapping.json");

  if (!process.env.BENCH_REMAP && !problem) {
    try {
      const parsed = columnMappingSchema.safeParse(JSON.parse(await readFile(cached, "utf8")));
      if (parsed.success) {
        console.log(`  mapping: cached (edit ${path.relative(process.cwd(), cached)} to probe)`);
        return parsed.data;
      }
      console.log("  mapping: cached copy no longer fits the schema — asking again");
    } catch {
      /* no cache yet */
    }
  }

  const sample = renderSample(grid);
  const { object } = await generateObject({
    model: process.env.AI_MODEL?.trim() || "anthropic/claude-sonnet-5",
    schema: columnMappingSchema,
    system: mapStatementColumnsPrompt.system,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: problem ? `${sample}\n\n${problem}` : sample }],
      },
    ],
  });

  if (!problem) await writeFile(cached, JSON.stringify(object, null, 2));
  return object;
}

/** Everything one document produced, on disk, for reading against the PDF itself. */
async function dump(name: string, files: Record<string, string>): Promise<void> {
  await mkdir(path.join(OUT, name), { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await writeFile(path.join(OUT, name, file), body);
  }
}

/** The grid as a human can read it beside the original: one row per line, real indices. */
function renderGrid(grid: Grid): string {
  return grid
    .map((row, index) => {
      const cells = row
        .map((cell, column) => ({ cell: cell.trim(), column }))
        .filter((entry) => entry.cell !== "")
        .map((entry) => `c${entry.column}=${JSON.stringify(entry.cell)}`);
      return `row ${String(index).padStart(4)} | ${cells.join(" | ")}`;
    })
    .join("\n");
}

/** The extracted lines as a table, for counting against the document by eye. */
function renderLines(
  lines: readonly {
    rowIndex: number;
    valueDate: string;
    description: string;
    amountMinor: bigint;
    direction: string;
    balanceMinor: bigint | null;
  }[],
): string {
  return lines
    .map(
      (line) =>
        `${String(line.rowIndex).padStart(4)} ${line.valueDate} ${line.direction.padEnd(6)} ${String(
          line.amountMinor,
        ).padStart(12)} ${String(line.balanceMinor ?? "-").padStart(14)}  ${line.description}`,
    )
    .join("\n");
}

const documents = readdirSync(INBOX)
  .filter((file) => file.toLowerCase().endsWith(".pdf") || file.toLowerCase().endsWith(".csv"))
  .filter(
    (file) =>
      !process.env.BENCH_ONLY || file.toLowerCase().includes(process.env.BENCH_ONLY.toLowerCase()),
  );

describe("parse bench", () => {
  for (const file of documents) {
    const name = file.replace(/\.(pdf|csv)$/i, "").replace(/\s+/g, "-");

    it(name, async () => {
      await mkdir(path.join(OUT, name), { recursive: true });
      console.log(`\n=== ${file} ===`);

      const bytes = new Uint8Array(await readFile(path.join(INBOX, file)));
      const source = await readStatementSource(bytes, extractPdfText);
      console.log(`  path: ${source.path}`);

      if (source.path === "SCANNED") {
        console.log(`  pages: ${source.pages} — vision path, not exercised by this bench yet`);
        return;
      }

      const currency = currencyFor(CURRENCIES[name] ?? "INR") as Currency;
      const grid = source.grid;
      const sample = renderSample(grid);

      await dump(name, { "grid.txt": renderGrid(grid), "sample.txt": sample });
      console.log(
        `  grid: ${grid.length} rows × ${grid.reduce((w, r) => Math.max(w, r.length), 0)} columns`,
      );
      console.log(
        `  sample shows the model ${Math.min(45, grid.length)} head + ${Math.min(15, Math.max(0, grid.length - 45))} tail of ${grid.length} rows`,
      );

      const map = await mapping(name, grid);
      if (!map) {
        console.log("  mapping: FAILED SCHEMA — statement would fail here");
        return;
      }

      const walk = walkStatement(grid, map, currency, undefined);
      const balances = balancesFromGrid(grid, map, walk.lines, currency);
      const anchor =
        balances.opening.source === "LOCATOR" || balances.opening.source === "STATED"
          ? balances.opening.minor
          : null;
      const audit = auditBalanceChain(walk.lines, anchor);
      const validation = validate(walk.lines, balances, audit);
      const before = transactionLikeRowsBefore(grid, map, currency, undefined);

      const report = parseReport({
        grid,
        mapping: map,
        walk,
        balances,
        validation,
        excluded:
          before.rows.length === 0
            ? null
            : {
                count: before.rows.length,
                firstRow: before.rows[0],
                lastRow: before.rows[before.rows.length - 1],
                firstDate: before.firstDate,
                lastDate: before.lastDate,
              },
        audit,
      });

      await dump(name, {
        "report.json": JSON.stringify(report, null, 2),
        "lines.txt": renderLines(walk.lines),
        "skipped.txt": walk.skipped
          .map((row) => `row ${String(row.rowIndex).padStart(4)} | ${row.reason}`)
          .join("\n"),
      });

      /*
       * The verdict, in the terms `docs/parsing-acceptance.md` judges a statement by. Not a
       * pass mark — only a human counting the document can award that — but every number
       * that decides one, in one place.
       */
      console.log(
        `  firstDataRow: ${map.firstDataRow} (headerRow ${map.headerRow}) — ${map.firstDataRow} rows never visited`,
      );
      console.log(
        `  amountShape: ${map.amountShape}  dateOrder: ${map.dateOrder}  decimal: "${map.decimalSeparator}"`,
      );
      console.log(`  lines: ${walk.lines.length}   skipped: ${walk.skipped.length}`);
      console.log(`  skipped by reason: ${JSON.stringify(report.skipped.byReason)}`);
      console.log(
        `  transaction-like rows ABOVE firstDataRow: ${before.rows.length}${before.rows.length ? ` (rows ${before.rows[0]}..${before.rows[before.rows.length - 1]}, ${before.firstDate}..${before.lastDate})` : ""}`,
      );
      console.log(
        `  dates extracted: ${report.extracted.firstDate} .. ${report.extracted.lastDate}`,
      );
      console.log(
        `  descriptions empty: ${walk.lines.filter((line) => line.description.trim() === "").length} of ${walk.lines.length}`,
      );
      console.log(
        `  opening: ${report.opening.minor} (${report.opening.source})   closing: ${report.closing.minor} (${report.closing.source})`,
      );
      console.log(
        `  chain: ${audit.coverage}, ${audit.checked} links checked, ${audit.breaks.length} broken ${JSON.stringify(report.chain.byKind)}`,
      );
      console.log(`  outcome: ${validation.outcome}  difference: ${report.differenceMinor}`);
      console.log(`  artifacts: bench/out/${name}/`);
    });
  }
});
