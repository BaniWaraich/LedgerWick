/**
 * The classification bench: the same transactions, judged by each candidate model.
 *
 * ## Why this exists
 *
 * `docs/architecture.md §21.2` leaves the model to evaluation. The first production
 * reconciliation made the question urgent: Sonnet 5 took 30 to 186 seconds for 40
 * transactions, and one statement cost about $2. This puts a cheaper, faster model next to
 * it on real transactions and writes down where the two disagree. The disagreements are
 * what a person has to read. Whether "needs a document" was right for a payment is a
 * judgment about the business, so nothing here asserts.
 *
 * It calls `classifyTransactions`, the production path, in batches of the size production
 * uses, so the prompt, the schema and the token counts are what the product would see.
 *
 * ## Input
 *
 * `bench/out/<name>/lines.txt`, written by the parse bench. No PDF is read and no mapping
 * is asked for here. Run the parse bench first for any statement you want to judge.
 *
 * ## Running it
 *
 *   npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts bench/classify.bench.ts
 *   BENCH_ONLY=hdfc-bank BENCH_MODELS=anthropic/claude-haiku-4.5 npx dotenv -e .env.local -- …
 *
 * Every run spends real money on every model named. `bench/out/` is git-ignored, since the
 * lines are unredacted.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, it, vi } from "vitest";

import type { TransactionBrief } from "../src/requirements/contracts";

vi.mock("server-only", () => ({}));

const { classifyTransactions } = await import("../src/requirements/classifier");
const { classifyTransactionsPrompt } = await import("../src/ai/prompts/classify-transactions.v1");

const OUT = path.resolve(__dirname, "out");

/** The same size `src/requirements/identify.ts` sends, so a call here is a call there. */
const BATCH_SIZE = 20;

const MODELS = (process.env.BENCH_MODELS ?? "anthropic/claude-sonnet-5,anthropic/claude-haiku-4.5")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

const STATEMENTS = readdirSync(OUT).filter(
  (name) =>
    existsSync(path.join(OUT, name, "lines.txt")) &&
    (!process.env.BENCH_ONLY || name.includes(process.env.BENCH_ONLY)),
);

/** The parse bench's `renderLines`, read back. */
function readLines(text: string, account: string): TransactionBrief[] {
  return text
    .split("\n")
    .map((line) => line.match(/^\s*\d+ (\S+) (DEBIT|CREDIT)\s+(\d+)\s+\S+\s{2}(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(([, valueDate, direction, amount, description], index) => ({
      index,
      valueDate,
      direction: direction as "DEBIT" | "CREDIT",
      amountMinor: BigInt(amount),
      currency: "INR",
      description,
      account,
    }));
}

interface Verdict {
  description: string;
  needsDocument: boolean | null;
  asked: string | null;
  vendorGuess: string | null;
  reason: string | null;
}

interface ModelRun {
  model: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  failedBatches: number;
  verdicts: Verdict[];
}

/** The `[timing]` line `inferStructure` writes, which is where the token counts live. */
function tokensFrom(lines: string[]): { input: number; output: number } {
  return lines.reduce(
    (total, line) => ({
      input: total.input + Number(line.match(/inputTokens=(\d+)/)?.[1] ?? 0),
      output: total.output + Number(line.match(/outputTokens=(\d+)/)?.[1] ?? 0),
    }),
    { input: 0, output: 0 },
  );
}

/**
 * A candidate is a model, optionally with a reasoning level: `anthropic/claude-sonnet-5@low`.
 *
 * The level is set on the prompt object the production classifier reads, and put back after,
 * so the call under test is the production call with one field changed.
 */
async function judge(candidate: string, transactions: TransactionBrief[]): Promise<ModelRun> {
  const [model, reasoning] = candidate.split("@");
  process.env.AI_MODEL = model;
  const prompt = classifyTransactionsPrompt as { reasoning?: string };
  const declared = prompt.reasoning;
  prompt.reasoning = reasoning ?? declared;
  const logged: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line === "string" && line.startsWith("[timing] stage=model")) logged.push(line);
  });

  const verdicts: Verdict[] = transactions.map((transaction) => ({
    description: transaction.description,
    needsDocument: null,
    asked: null,
    vendorGuess: null,
    reason: null,
  }));
  let failedBatches = 0;
  const started = Date.now();

  try {
    for (let start = 0; start < transactions.length; start += BATCH_SIZE) {
      const batch = transactions
        .slice(start, start + BATCH_SIZE)
        .map((transaction, index) => ({ ...transaction, index }));
      const answer = await classifyTransactions({ transactions: batch, known: [] });

      if (!answer.ok) {
        failedBatches += 1;
        continue;
      }
      for (const judgement of answer.value.judgements) {
        const verdict = verdicts[start + judgement.index];
        if (!verdict || judgement.index >= batch.length) continue;
        verdict.needsDocument = judgement.confident ? judgement.needsDocument : null;
        verdict.asked = judgement.clarification?.question ?? null;
        verdict.vendorGuess = judgement.vendorGuess;
        verdict.reason = judgement.reason;
      }
    }
  } finally {
    log.mockRestore();
    prompt.reasoning = declared;
  }

  const tokens = tokensFrom(logged);
  return {
    model: candidate,
    ms: Date.now() - started,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    failedBatches,
    verdicts,
  };
}

function outcome(verdict: Verdict): string {
  if (verdict.asked) return "ASK";
  if (verdict.needsDocument === null) return "—";
  return verdict.needsDocument ? "NEEDS" : "no";
}

/** One row per transaction the models did not agree on, and a line per model. */
function compare(runs: ModelRun[]): string {
  const summary = runs.map(
    (run) =>
      `${run.model}: ${run.ms} ms, ${run.inputTokens} in / ${run.outputTokens} out tokens, ` +
      `${run.verdicts.filter((v) => v.needsDocument).length} need a document, ` +
      `${run.verdicts.filter((v) => v.asked).length} questions, ` +
      `${run.failedBatches} failed batches`,
  );

  const [first] = runs;
  const disagreements = first.verdicts
    .map((verdict, index) => ({ verdict, index }))
    .filter(({ index }) => new Set(runs.map((run) => outcome(run.verdicts[index]))).size > 1)
    .map(({ verdict, index }) =>
      [
        `${index}. ${verdict.description}`,
        ...runs.map((run) => {
          const theirs = run.verdicts[index];
          return `   ${outcome(theirs).padEnd(5)} ${run.model}: ${theirs.asked ?? theirs.reason ?? ""}`;
        }),
      ].join("\n"),
    );

  return [
    ...summary,
    "",
    `${disagreements.length} of ${first.verdicts.length} judged differently:`,
    "",
    ...disagreements,
  ].join("\n");
}

describe("classification, model against model", () => {
  for (const name of STATEMENTS) {
    it(name, async () => {
      const transactions = readLines(
        await readFile(path.join(OUT, name, "lines.txt"), "utf8"),
        name,
      );

      const runs: ModelRun[] = [];
      for (const model of MODELS) runs.push(await judge(model, transactions));

      const dir = path.join(OUT, name, "classify");
      await mkdir(dir, { recursive: true });
      for (const run of runs) {
        await writeFile(
          path.join(dir, `${run.model.replaceAll(/[/@]/g, "_")}.json`),
          JSON.stringify(run, null, 2),
        );
      }
      await writeFile(path.join(dir, "comparison.txt"), compare(runs));
    });
  }
});
