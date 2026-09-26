/**
 * The retrieval bench: search a real mailbox for real payments, and write down the reasoning.
 *
 * ## Why this exists
 *
 * `docs/retrieval-acceptance.md` needs the one measurement no test can make: how the real
 * reader and the real adjudicator behave on mail nobody wrote for a test. The deterministic
 * eval (`tests/retrieval/eval.test.ts`) proves the policy refuses every wrong link in its
 * set under a model that agrees with everything. It cannot show that a real receipt is read
 * correctly, or that a real model vetoes what it should.
 *
 * So each requirement's run is dumped **decision first, beside everything that produced
 * it**: where it searched, which emails it looked at and why, what each document turned out
 * to be, what matching made of it, and which term of the settle conjunction held or failed.
 *
 *     decision   NEEDS_REVIEW   blocked by: one document supports this payment
 *       · one document supports this payment   ✗
 *       ...
 *
 * A wrong link is obvious. A right link for the wrong reason is only obvious when you can
 * see which evidence carried it.
 *
 * It is a microscope, not a test: nothing asserts, and a red run means the harness broke.
 * A requirement's verdict goes in the log in `docs/retrieval-acceptance.md`, written by a
 * person, **before** anything is fixed.
 *
 * ## It runs the real thing
 *
 * Unlike the matching bench, there is no dry run. Retrieval's work is to store documents
 * and move requirements, and a bench that did neither would be measuring something else.
 * So point it only at a development workspace, connected to a test mailbox, on the dev
 * database branch -- never at production. Every model call is a real one, with real spend.
 *
 * ## Running it
 *
 *   BENCH_WORKSPACE=<uuid> BENCH_USER=<owner user id> \
 *     npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts retrieval
 *
 * `BENCH_ONLY=anthropic` limits it to requirements whose vendor or id contains that text.
 * Needs `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `GOOGLE_CLIENT_ID`/`SECRET`,
 * `GMAIL_TOKEN_KEY` and gateway credit (`BAN-149`). Without the workspace it skips.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";
import { describe, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const OUT = path.resolve(__dirname, "out/retrieval");

describe("retrieving real documents for real payments", () => {
  const workspaceId = process.env.BENCH_WORKSPACE;
  const userId = process.env.BENCH_USER;
  const ready = Boolean(process.env.DATABASE_URL && workspaceId && userId);

  if (!ready) {
    it.skip("needs DATABASE_URL, BENCH_WORKSPACE and BENCH_USER", () => {});
    return;
  }

  it("runs every searchable requirement in the workspace", async () => {
    const { getDb } = await import("../src/db/client");
    const schema = await import("../src/db/schema");
    const { openWorkspace } = await import("../src/db/workspace-scope");
    const { gmailClient } = await import("../src/gmail/mail");
    const { googleOAuthClient } = await import("../src/gmail/oauth");
    const { getDocumentStore } = await import("../src/storage/blob-store");
    const { readInvoice } = await import("../src/documents/reader");
    const { extractPdfText } = await import("../src/statements/pdf-text");
    const adjudicator = await import("../src/matching/adjudicator");
    const { searchRequirement } = await import("../src/retrieval/search");
    const { documentsFor, fetchForRequirement } = await import("../src/retrieval/fetch");
    const { assessDocument, settleRetrieval } = await import("../src/retrieval/assess");
    const { RETRIEVAL_TERMS } = await import("../src/retrieval/decide");
    const { describeAllEmail } = await import("../src/retrieval/evidence");
    const { SEARCHABLE_STATES } = await import("../src/retrieval/requirement-state");

    const scope = await openWorkspace(getDb(), userId!, workspaceId!);
    const store = getDocumentStore();
    const gmail = { oauth: googleOAuthClient(), gmail: gmailClient() };
    const assessDeps = {
      understand: { store, extractPdfText, read: readInvoice },
      match: {
        adjudicate: adjudicator.adjudicateMatch,
        judgeSameInvoice: adjudicator.judgeSameInvoice,
        formatAmount: adjudicator.formatForPrompt,
      },
    };

    const only = process.env.BENCH_ONLY?.toLowerCase();
    const requirements = (
      await scope.select(
        schema.invoiceRequirements,
        inArray(schema.invoiceRequirements.state, [...SEARCHABLE_STATES]),
      )
    ).filter(
      (r) => !only || r.id.includes(only) || (r.vendorGuess ?? "").toLowerCase().includes(only),
    );

    if (requirements.length === 0) {
      console.log("no searchable requirements in this workspace");
      return;
    }

    for (const requirement of requirements) {
      const name = `${(requirement.vendorGuess ?? "unknown").replace(/[^a-z0-9]+/gi, "-")}-${requirement.id.slice(0, 8)}`;
      console.log(`\n${name}`);
      const lines: string[] = [];
      const say = (line = "") => lines.push(line);

      const transaction = await scope.selectOne(
        schema.canonicalTransactions,
        eq(schema.canonicalTransactions.id, requirement.canonicalTransactionId),
      );
      say("## The payment");
      say();
      say(`  ${transaction?.valueDate}   ${transaction?.currency} ${transaction?.amountMinor}`);
      say(`  ${transaction?.description}`);
      say(`  vendor guess: ${requirement.vendorGuess ?? "—"}`);
      say();

      let decision = "not reached";
      let blockedBy: string | null = null;
      try {
        const searched = await searchRequirement(scope, requirement.id, gmail);
        if (searched.kind === "SEARCHED" && searched.next === "FETCH") {
          const fetched = await fetchForRequirement(scope, requirement.id, { ...gmail, store });
          if (fetched.next === "ASSESS") {
            const assessments = [];
            for (const documentId of await documentsFor(scope, requirement.id)) {
              assessments.push(await assessDocument(scope, documentId, assessDeps));
            }
            say("## The documents");
            say();
            for (const a of assessments) {
              say(`  ${a.documentId.slice(0, 8)}   ${a.state}   ${a.classification ?? "—"}`);
              say(
                `             candidates: ${a.candidateTransactionIds.length}` +
                  `${a.candidateTransactionIds.includes(requirement.canonicalTransactionId) ? " (this payment among them)" : ""}`,
              );
              say(
                `             matching: ${a.autoMatchTransactionId ? `would link ${a.autoMatchTransactionId === requirement.canonicalTransactionId ? "THIS payment" : "ANOTHER payment"}` : `no link — ${a.blockedBy ?? "no candidates"}`}`,
              );
            }
            say();
            const settled = await settleRetrieval(scope, requirement.id, assessments);
            if (settled.kind === "SETTLED") {
              decision = settled.settlement.kind;
              blockedBy =
                settled.settlement.kind === "NEEDS_REVIEW" ? settled.settlement.blockedBy : null;
            }
          } else {
            decision = fetched.next;
          }
        } else {
          decision = searched.kind === "SEARCHED" ? searched.next : searched.kind;
        }
      } catch (error) {
        decision = `FAILED — ${error instanceof Error ? error.name : String(error)}`;
      }

      const searches = await scope.select(
        schema.mailboxSearches,
        eq(schema.mailboxSearches.requirementId, requirement.id),
      );
      const emails = await scope.select(
        schema.candidateEmails,
        eq(schema.candidateEmails.requirementId, requirement.id),
      );

      const head = [
        "## The decision",
        "",
        `  ${decision}${blockedBy ? `   blocked by: ${blockedBy}` : ""}`,
        "",
        ...RETRIEVAL_TERMS.map((term) => `    ${term === blockedBy ? "✗" : "·"} ${term}`),
        "",
        "## Where it looked",
        "",
        ...searches.map(
          (s) =>
            `  ${s.gmailConnectionId.slice(0, 8)}   ${s.windowStart} → ${s.windowEnd}   ${s.outcome}   ${s.messagesFound} found${s.truncated ? "   TRUNCATED" : ""}`,
        ),
        "",
        "## The emails",
        "",
        ...emails.flatMap((e) => [
          `  ${e.selected ? "▶" : " "} ${e.subject}`,
          `      from ${e.fromHeader}   (${e.foundBy})   ${e.fetchOutcome ?? (e.selected ? "not fetched" : "not selected")}`,
          ...describeAllEmail(e.evidence as never).map((line) => `      ${line}`),
          "",
        ]),
      ];

      await mkdir(path.join(OUT, name), { recursive: true });
      await writeFile(path.join(OUT, name, "decision.txt"), [...head, ...lines].join("\n"));
      console.log(`  ${decision}${blockedBy ? ` — ${blockedBy}` : ""}`);
    }
  });
});
