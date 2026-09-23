/**
 * Narrowing the transactions an invoice might have paid for.
 *
 * spec: docs/workflows/manual-invoice-upload.md §8 · docs/architecture.md §10 Stage 1
 *
 * Integration rather than unit, because the narrowing is a query and the thing worth
 * testing is what the query excluded. A mock would return whatever the test set up, which
 * is the one property under test here.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import { canonicalTransactions, invoices, vendorAliases, vendors } from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { generateCandidates } from "../../src/matching/candidates";
import { CANDIDATE_FETCH_CAP, CANDIDATES_SHOWN_TO_MODEL } from "../../src/matching/thresholds";
import type { InvoiceFacts } from "../../src/matching/evidence";

let h: TestDb;
let scope: WorkspaceScope;
let workspaceId: string;
let bankAccountId: string;

beforeEach(async () => {
  h = await createTestDb();
  const { workspace, user } = await seedWorkspace(h.db);
  workspaceId = workspace.id;
  bankAccountId = (await seedBankAccount(h.db, workspaceId)).id;
  scope = new WorkspaceScope(h.db, workspaceId, user.id);
});

afterEach(async () => {
  await h.close();
});

async function insertTransaction(overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
    .insert(canonicalTransactions)
    .values({
      workspaceId,
      bankAccountId,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      direction: "DEBIT" as const,
      currency: "USD",
      description: "ANTHROPIC",
      descriptionNormalized: "anthropic",
      occurrenceIndex: 0,
      ...overrides,
    })
    .returning();
  return row;
}

async function insertInvoice(overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
    .insert(invoices)
    .values({ workspaceId, totalMinor: 2000n, currency: "USD", ...overrides })
    .returning();
  return row;
}

function facts(id: string, overrides: Partial<InvoiceFacts> = {}): InvoiceFacts & { id: string } {
  return {
    id,
    invoiceNumber: "INV-92831",
    invoiceDate: "2026-04-14",
    totalMinor: 2000n,
    currency: "USD",
    vendorId: null,
    vendorName: "Anthropic",
    vendorKeys: ["anthropic"],
    ...overrides,
  };
}

describe("the window the search is bounded by", () => {
  it("proposes a payment that settled days after the invoice", async () => {
    const txn = await insertTransaction({ valueDate: "2026-04-21" });
    const invoice = await insertInvoice();

    const { candidates } = await generateCandidates(scope, facts(invoice.id));

    expect(candidates.map((c) => c.transaction.id)).toEqual([txn.id]);
  });

  it("does not propose a payment from a month earlier", async () => {
    await insertTransaction({ valueDate: "2026-03-14" });
    const invoice = await insertInvoice();

    const { candidates } = await generateCandidates(scope, facts(invoice.id));

    expect(candidates).toHaveLength(0);
  });

  it("does not propose a payment from long after", async () => {
    await insertTransaction({ valueDate: "2026-06-01" });
    const invoice = await insertInvoice();

    expect((await generateCandidates(scope, facts(invoice.id))).candidates).toHaveLength(0);
  });

  it("returns nothing at all for an invoice with no date", async () => {
    // The window is derived from the invoice date. Without one there is nothing to search
    // but everything, and an unbounded scan inside a function with a wall-clock budget is
    // the failure this guards. hasMinimumFields makes it unreachable today; it is one
    // relaxation away from being reachable.
    await insertTransaction();
    const invoice = await insertInvoice();

    const { candidates } = await generateCandidates(
      scope,
      facts(invoice.id, { invoiceDate: null }),
    );

    expect(candidates).toHaveLength(0);
  });
});

describe("what is never offered", () => {
  it("never proposes money coming in", async () => {
    // domain-model.md §11.1 puts incoming credits outside V1, and identify.ts already
    // refuses a requirement for one. An invoice is a charge.
    await insertTransaction({ direction: "CREDIT" });
    const invoice = await insertInvoice();

    expect((await generateCandidates(scope, facts(invoice.id))).candidates).toHaveLength(0);
  });

  it("never proposes a transaction that already holds an invoice", async () => {
    // invoices_transaction_idx would refuse the write anyway. Offering it would be
    // offering the user a dead end.
    const txn = await insertTransaction();
    await insertInvoice({ canonicalTransactionId: txn.id, invoiceNumber: "OTHER" });
    const mine = await insertInvoice();

    expect((await generateCandidates(scope, facts(mine.id))).candidates).toHaveLength(0);
  });

  it("still offers an invoice the transaction it is already linked to", async () => {
    // A re-run must find its own link intact, or a retry would report the transaction as
    // taken by a stranger and downgrade a settled match.
    const txn = await insertTransaction();
    const invoice = await insertInvoice({ canonicalTransactionId: txn.id });

    const { candidates } = await generateCandidates(scope, facts(invoice.id));

    expect(candidates.map((c) => c.transaction.id)).toEqual([txn.id]);
  });

  it("does not pad the list with transactions that merely happened nearby", async () => {
    // In the window, but agreeing on neither amount nor vendor. A shortlist whose tail is
    // noise teaches the user to stop reading it.
    await insertTransaction({
      amountMinor: 999999n,
      description: "ELECTRICITY BOARD",
      descriptionNormalized: "electricity board",
    });
    const invoice = await insertInvoice();

    expect((await generateCandidates(scope, facts(invoice.id))).candidates).toHaveLength(0);
  });

  it("never reaches into another workspace", async () => {
    const other = await seedWorkspace(h.db, "Someone Else");
    const otherAccount = await seedBankAccount(h.db, other.workspace.id);
    await h.db.insert(canonicalTransactions).values({
      workspaceId: other.workspace.id,
      bankAccountId: otherAccount.id,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      direction: "DEBIT",
      currency: "USD",
      description: "ANTHROPIC",
      descriptionNormalized: "anthropic",
      occurrenceIndex: 0,
    });
    const invoice = await insertInvoice();

    expect((await generateCandidates(scope, facts(invoice.id))).candidates).toHaveLength(0);
  });
});

describe("keeping the shortlist short", () => {
  it("shows only the best few, and says the read was capped", async () => {
    // One more than the cap so the read genuinely hits it.
    const rows = Array.from({ length: CANDIDATE_FETCH_CAP + 20 }, (_, i) => ({
      workspaceId,
      bankAccountId,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      direction: "DEBIT" as const,
      currency: "USD",
      description: "ANTHROPIC",
      descriptionNormalized: "anthropic",
      occurrenceIndex: i,
    }));
    await h.db.insert(canonicalTransactions).values(rows);
    const invoice = await insertInvoice();

    const set = await generateCandidates(scope, facts(invoice.id));

    expect(set.candidates).toHaveLength(CANDIDATES_SHOWN_TO_MODEL);
    // A shortlist presented as exhaustive is a lie the user cannot detect, and §10's "no
    // reliable match" reads differently if the system never looked at everything.
    expect(set.truncated).toBe(true);
  });

  it("does not claim truncation when it saw everything", async () => {
    await insertTransaction();
    const invoice = await insertInvoice();

    expect((await generateCandidates(scope, facts(invoice.id))).truncated).toBe(false);
  });

  it("ranks the exact amount above the near miss", async () => {
    const near = await insertTransaction({ amountMinor: 2015n, occurrenceIndex: 1 });
    const exact = await insertTransaction({ amountMinor: 2000n, occurrenceIndex: 2 });
    const invoice = await insertInvoice();

    const { candidates } = await generateCandidates(scope, facts(invoice.id));

    expect(candidates[0].transaction.id).toBe(exact.id);
    expect(candidates[0].rank).toBe(0);
    expect(candidates[1].transaction.id).toBe(near.id);
    expect(candidates[1].rank).toBe(1);
  });

  it("ranks two identical candidates the same way every time", async () => {
    // A retry presenting a different "best" match than the attempt before it is a
    // difference the user would see and could not explain.
    await insertTransaction({ occurrenceIndex: 1 });
    await insertTransaction({ occurrenceIndex: 2 });
    const invoice = await insertInvoice();

    const first = await generateCandidates(scope, facts(invoice.id));
    const second = await generateCandidates(scope, facts(invoice.id));

    expect(first.candidates.map((c) => c.transaction.id)).toEqual(
      second.candidates.map((c) => c.transaction.id),
    );
  });
});

describe("how the vendor was recognised", () => {
  it("separates a confirmed alias from one the extraction guessed", async () => {
    // architecture.md §11: only a confirmed alias is Business Knowledge. The evidence
    // says which kind was used rather than flattening both into "the vendor matched".
    const [vendor] = await h.db
      .insert(vendors)
      .values({ workspaceId, name: "Anthropic" })
      .returning();
    await h.db.insert(vendorAliases).values({
      workspaceId,
      vendorId: vendor.id,
      alias: "ANTHROPIC",
      aliasNormalized: "anthropic",
      confirmed: true,
    });

    await insertTransaction();
    const invoice = await insertInvoice({ vendorId: vendor.id });

    const { candidates } = await generateCandidates(
      scope,
      facts(invoice.id, { vendorId: vendor.id }),
    );
    const vendorEvidence = candidates[0].evidence.find((e) => e.kind === "VENDOR");

    expect(vendorEvidence?.kind === "VENDOR" && vendorEvidence.agreement).toBe("RESOLVED");
  });

  it("falls back to the name appearing in the description", async () => {
    // §7's example: RAZORPAY*ABCFOODS resolving to ABC Foods, with no vendor record yet.
    await insertTransaction({
      description: "RAZORPAY*ABCFOODS",
      descriptionNormalized: "razorpayabcfoods",
    });
    const invoice = await insertInvoice();

    const { candidates } = await generateCandidates(
      scope,
      facts(invoice.id, { vendorKeys: ["abcfoods"], vendorName: "ABC Foods Private Limited" }),
    );
    const vendorEvidence = candidates[0].evidence.find((e) => e.kind === "VENDOR");

    expect(vendorEvidence?.kind === "VENDOR" && vendorEvidence.agreement).toBe(
      "NORMALIZED_CONTAINS",
    );
  });
});
