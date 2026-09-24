/**
 * The matching bench: put an invoice against real transactions and write down the reasoning.
 *
 * ## Why this exists
 *
 * `docs/matching-acceptance.md` says the only evidence matching generalises is how often
 * it is wrong about an invoice it has never seen, and names the error it has to make
 * visible: a **false positive** — an invoice attached confidently to the wrong payment.
 *
 * Nothing in the code can catch that. A wrong link satisfies every constraint in the
 * database: the invoice is linked, the requirement is resolved, the 1:1 rule holds. It is
 * only wrong against a document and a bank statement, which is to say only against a
 * person holding both.
 *
 * So the dump leads with **the decision next to the evidence that produced it**, and with
 * the term that stopped an automatic link when one was stopped:
 *
 *     decision   NEEDS_REVIEW   blocked by: the vendor is known
 *     rank 0     ANTHROPIC   $20.00   2026-04-14
 *                Amount matches exactly
 *                Dated the same day as the transaction
 *                Vendor name appears in ANTHROPIC
 *
 * A wrong link is obvious. A right link made for the wrong reason is only obvious if you
 * can see which evidence carried it.
 *
 * It is a microscope, not a test: nothing in here asserts, and a red run means the harness
 * broke, not that an invoice failed. A document's verdict goes in the log in
 * `docs/matching-acceptance.md`, written by a person, before anything is fixed.
 *
 * ## The adjudication cache
 *
 * `bench/out/matching/<name>/adjudication.json` is written on the first run and reused
 * after, exactly as the parse and extraction benches cache theirs, and for the same two
 * reasons. Iterating on `decide.ts` or `thresholds.ts` is then free and instant with no
 * spend, and a cached answer can be **edited by hand** — which is how you ask "did the
 * model choose wrongly, or did the policy weigh it wrongly?" without changing code.
 *
 * `BENCH_REJUDGE=1` throws the cache away and asks the model again.
 *
 * ## Running it
 *
 *   npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts
 *   BENCH_ONLY=acme npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts
 *
 * It needs a database with real transactions in it, because candidate generation is a
 * query and a synthetic transaction proves nothing about narrowing. Point `DATABASE_URL`
 * at the dev branch, and set `BENCH_WORKSPACE` to the workspace whose statements to match
 * against. Without those it skips rather than failing.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { describe, it } from "vitest";

import {
  adjudicateMatchPrompt,
  matchAdjudicationSchema,
  type MatchAdjudication,
} from "../src/ai/prompts/adjudicate-match.v1";
import { generateCandidates } from "../src/matching/candidates";
import { AUTO_MATCH_TERMS, decideOutcome } from "../src/matching/decide";
import { describeAll, type InvoiceFacts } from "../src/matching/evidence";
import { invoiceDocuments, invoices, vendorAliases, vendors } from "../src/db/schema";
import { WorkspaceScope } from "../src/db/workspace-scope";
import { vendorLookupKeys } from "../src/documents/vendors";
import { currencyFor } from "../src/money/currencies";
import { formatAmount } from "../src/money/format";

const OUT = path.resolve(__dirname, "out/matching");

function money(minor: bigint | null, code: string | null): string {
  if (minor === null || code === null) return "—";
  const currency = currencyFor(code);
  return currency ? formatAmount(minor, currency) : `${code} ${minor}`;
}

/** The adjudication for this invoice: from disk if it is there, from the model otherwise. */
async function adjudication(
  name: string,
  prompt: string,
): Promise<MatchAdjudication | { failed: string }> {
  const cached = path.join(OUT, name, "adjudication.json");

  if (!process.env.BENCH_REJUDGE) {
    try {
      const parsed = matchAdjudicationSchema.safeParse(JSON.parse(await readFile(cached, "utf8")));
      if (parsed.success) {
        console.log(
          `  adjudication: cached (edit ${path.relative(process.cwd(), cached)} to probe)`,
        );
        return parsed.data;
      }
      console.log("  adjudication: cached copy no longer fits the schema — asking again");
    } catch {
      /* no cache yet */
    }
  }

  try {
    const { object } = await generateObject({
      model: process.env.AI_MODEL?.trim() || "anthropic/claude-sonnet-5",
      schema: matchAdjudicationSchema,
      system: adjudicateMatchPrompt.system,
      prompt,
    });

    await mkdir(path.join(OUT, name), { recursive: true });
    await writeFile(path.join(OUT, name, "adjudication.json"), JSON.stringify(object, null, 2));

    return object;
  } catch (error) {
    // A gateway with no credit, or a schema the model could not satisfy. Both are
    // outcomes worth seeing in the dump rather than a stack trace that stops the run.
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/** Everything one invoice's run produced, as a page to read beside the document. */
function render(
  invoice: InvoiceFacts,
  candidates: { rank: number; evidence: unknown[]; lines: string[]; summary: string }[],
  truncated: boolean,
  verdict: MatchAdjudication | { failed: string },
  decision: { kind: string; blockedBy?: string; rank?: number },
): string {
  const head = [
    "## The invoice",
    "",
    `  vendor   ${invoice.vendorName ?? "—"}`,
    `  number   ${invoice.invoiceNumber ?? "—"}`,
    `  dated    ${invoice.invoiceDate ?? "—"}`,
    `  total    ${money(invoice.totalMinor, invoice.currency)}`,
    "",
    "## The decision",
    "",
    `  ${decision.kind}${decision.blockedBy ? `   blocked by: ${decision.blockedBy}` : ""}`,
    "",
    // Every term, so a reader can see which ones held as well as which one did not.
    ...AUTO_MATCH_TERMS.map((term) => `    ${term === decision.blockedBy ? "✗" : "·"} ${term}`),
    "",
    `  model    ${"failed" in verdict ? `could not answer — ${verdict.failed}` : `${verdict.verdict} on candidate ${verdict.candidate ?? "none"} — ${verdict.reason}`}`,
    `  shortlist${truncated ? " TRUNCATED — the read hit its cap and this is not everything" : " complete"}`,
    "",
    "## The candidates",
    "",
  ];

  const body =
    candidates.length === 0
      ? ["  none — nothing on the statements was close enough to propose"]
      : candidates.flatMap((candidate) => [
          `  rank ${candidate.rank}   ${candidate.summary}`,
          ...candidate.lines.map((line) => `             ${line}`),
          "",
        ]);

  return [...head, ...body].join("\n");
}

describe("matching real invoices against real transactions", () => {
  const workspaceId = process.env.BENCH_WORKSPACE;
  const ready = Boolean(process.env.DATABASE_URL && workspaceId);

  if (!ready) {
    it.skip("needs DATABASE_URL and BENCH_WORKSPACE to have anything to match against", () => {});
    return;
  }

  const names = existsSync(OUT) ? readdirSync(OUT) : [];
  const only = process.env.BENCH_ONLY;

  it("reads every unlinked invoice in the workspace", async () => {
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const scope = new WorkspaceScope(db, workspaceId!, "bench");

    const unlinked = (await scope.select(invoices)).filter(
      (invoice) => invoice.canonicalTransactionId === null,
    );

    if (unlinked.length === 0) {
      console.log("no unlinked invoices in this workspace — upload one first");
      return;
    }

    for (const invoice of unlinked) {
      const name = `${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`;
      if (only && !name.toLowerCase().includes(only.toLowerCase())) continue;

      const vendor =
        invoice.vendorId === null
          ? null
          : await scope.selectOne(vendors, eq(vendors.id, invoice.vendorId));
      const aliases =
        invoice.vendorId === null
          ? []
          : await scope.select(vendorAliases, eq(vendorAliases.vendorId, invoice.vendorId));

      const [primaryDocument] = await scope.select(
        invoiceDocuments,
        eq(invoiceDocuments.invoiceId, invoice.id),
      );

      const facts: InvoiceFacts & { id: string; documentId: string | null } = {
        id: invoice.id,
        documentId: primaryDocument?.documentId ?? null,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        totalMinor: invoice.totalMinor,
        currency: invoice.currency,
        vendorId: invoice.vendorId,
        vendorName: vendor?.name ?? null,
        vendorKeys: vendorLookupKeys([
          vendor?.name,
          vendor?.legalName,
          ...aliases.map((a) => a.alias),
        ]),
      };

      console.log(`\n${name}`);

      const { candidates, truncated } = await generateCandidates(scope, facts);

      const described = candidates.map((candidate) => ({
        rank: candidate.rank,
        evidence: candidate.evidence as unknown[],
        lines: describeAll(candidate.evidence),
        summary: `${candidate.transaction.description}   ${money(
          candidate.transaction.amountMinor,
          candidate.transaction.currency,
        )}   ${candidate.transaction.valueDate}`,
      }));

      const prompt = [
        "## The invoice",
        "",
        `Vendor: ${facts.vendorName ?? "not read from the document"}`,
        `Number: ${facts.invoiceNumber ?? "none on the document"}`,
        `Dated: ${facts.invoiceDate ?? "not read from the document"}`,
        `Total: ${money(facts.totalMinor, facts.currency)}`,
        "",
        "## The payments",
        "",
        ...described.map((candidate) =>
          [
            `${candidate.rank}. ${candidate.summary}`,
            ...candidate.lines.map((l) => `   - ${l}`),
          ].join("\n"),
        ),
      ].join("\n");

      const verdict =
        candidates.length === 0
          ? { failed: "no candidates to judge" }
          : await adjudication(name, prompt);

      const decision = decideOutcome({
        candidates: candidates.map((c) => ({ rank: c.rank, evidence: c.evidence })),
        adjudication:
          "failed" in verdict
            ? null
            : {
                candidateRank: verdict.candidate,
                verdict: verdict.verdict,
                reason: verdict.reason,
              },
        suspectedDuplicate: invoice.suspectedDuplicateOfInvoiceId !== null,
        truncated,
      });

      const page = render(facts, described, truncated, verdict, decision);
      console.log(page);

      await mkdir(path.join(OUT, name), { recursive: true });
      await writeFile(path.join(OUT, name, "decision.txt"), page);
      await writeFile(
        path.join(OUT, name, "candidates.json"),
        JSON.stringify(
          described,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
          2,
        ),
      );
    }

    console.log(`\nwrote ${path.relative(process.cwd(), OUT)} — read each beside its document`);
    console.log(`existing dumps: ${names.length}`);
  });
});
