/**
 * The report, read from a real database.
 *
 * spec: docs/workflows/missing-invoice-report.md §3, §5, §6, §7 ·
 * docs/workflows/invoice-match-review.md §11
 * decision: docs/decisions/0014-report-counts-live-across-the-workspace.md
 *
 * Requirement states are seeded directly: nothing produces `BLOCKED` until Gmail
 * connections exist, and the report must already treat it correctly when something does.
 * Review decisions are made through `src/review/resolve.ts` itself, because what matters is
 * that the report follows the writes the product actually makes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  bankAccounts,
  bankStatements,
  canonicalTransactions,
  clarificationQuestions,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  reconciliationRuns,
  supportingDocuments,
  vendors,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { missingInvoiceReport, type MissingInvoiceReport } from "../../src/report/report";
import { confirmCandidate, markNotRequired, rejectAllCandidates } from "../../src/review/resolve";

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

let day = 0;

async function insertTransaction(direction: "DEBIT" | "CREDIT" = "DEBIT") {
  day += 1;
  const [row] = await h.db
    .insert(canonicalTransactions)
    .values({
      workspaceId,
      bankAccountId,
      valueDate: `2026-03-${String((day % 28) + 1).padStart(2, "0")}`,
      amountMinor: BigInt(1000 + day),
      direction,
      currency: "INR",
      description: `PAYMENT ${day}`,
      descriptionNormalized: `payment ${day}`,
    })
    .returning();
  return row;
}

async function insertRequirement(
  transactionId: string,
  state: (typeof invoiceRequirements.$inferInsert)["state"],
  resolutionMethod: (typeof invoiceRequirements.$inferInsert)["resolutionMethod"] = null,
) {
  const [row] = await h.db
    .insert(invoiceRequirements)
    .values({ workspaceId, canonicalTransactionId: transactionId, state, resolutionMethod })
    .returning();
  return row;
}

/** An invoice proposed for this transaction, as matching leaves one for review. */
async function proposeInvoice(transactionId: string) {
  const [vendor] = await h.db.insert(vendors).values({ workspaceId, name: "Vendor" }).returning();
  const [document] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "documents/x.pdf",
      filename: "Invoice.pdf",
      mimeType: "application/pdf",
      source: "MANUAL_UPLOAD",
      state: "EXTRACTED",
    })
    .returning();
  const [invoice] = await h.db
    .insert(invoices)
    .values({ workspaceId, vendorId: vendor.id, totalMinor: 1000n, currency: "INR" })
    .returning();
  await h.db
    .insert(invoiceDocuments)
    .values({ workspaceId, invoiceId: invoice.id, documentId: document.id, isPrimary: true });
  await h.db.insert(invoiceMatchCandidates).values({
    workspaceId,
    invoiceId: invoice.id,
    canonicalTransactionId: transactionId,
    rank: 0,
    evidence: [],
  });
  return invoice;
}

async function insertStatement(state: "COMPLETED" | "FAILED", accountId = bankAccountId) {
  await h.db.insert(bankStatements).values({
    workspaceId,
    bankAccountId: accountId,
    uploadBatchId: crypto.randomUUID(),
    filename: "statement.csv",
    mimeType: "text/csv",
    storageRef: "statements/x.csv",
    state,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
  });
}

function expectSumHolds({ summary }: MissingInvoiceReport) {
  expect(
    summary.matched + summary.notFound + summary.needsReview + summary.waiting + summary.blocked,
  ).toBe(summary.documentsRequired);
}

describe("the missing invoice report", () => {
  it("reports live requirement state and follows a review decision", async () => {
    await insertStatement("COMPLETED");
    const [run] = await h.db
      .insert(reconciliationRuns)
      .values({
        workspaceId,
        state: "COMPLETED",
        coverageStart: "2026-03-01",
        coverageEnd: "2026-03-31",
        // Per-run numbers from an earlier, smaller run. The report must not show them.
        transactionsProcessed: 1,
        documentsRequired: 0,
      })
      .returning();

    const debits = [];
    for (let i = 0; i < 8; i++) debits.push(await insertTransaction("DEBIT"));
    await insertTransaction("CREDIT");
    await insertTransaction("CREDIT");

    await insertRequirement(debits[0].id, "RESOLVED", "AUTO_MATCHED");
    await insertRequirement(debits[1].id, "RESOLVED", "NOT_REQUIRED");
    const notFound = await insertRequirement(debits[2].id, "NOT_FOUND");
    const needsReview = await insertRequirement(debits[3].id, "NEEDS_REVIEW");
    const invoice = await proposeInvoice(debits[3].id);
    await insertRequirement(debits[4].id, "IDENTIFIED");
    await insertRequirement(debits[5].id, "BLOCKED");

    const before = await missingInvoiceReport(scope, "all");

    expect(before.transactionsProcessed).toBe(10);
    expect(before.summary).toEqual({
      documentsRequired: 5,
      matched: 1,
      notFound: 1,
      needsReview: 1,
      waiting: 1,
      blocked: 1,
      notRequired: 1,
    });
    expectSumHolds(before);
    expect(before.queue.map((row) => row.requirement.state)).toEqual([
      "NEEDS_REVIEW",
      "NOT_FOUND",
      "IDENTIFIED",
    ]);
    expect(before.run?.id).toBe(run.id);
    expect(before.run?.coverageStart).toBe("2026-03-01");
    expect(before.run?.coverageEnd).toBe("2026-03-31");
    expect(before.accounts).toEqual([{ id: bankAccountId, name: "HDFC Bank XXXX1234" }]);

    const reviewOnly = await missingInvoiceReport(scope, "needs-review");
    expect(reviewOnly.queue.map((row) => row.requirement.id)).toEqual([needsReview.id]);
    // A filter narrows the queue and nothing else.
    expect(reviewOnly.summary).toEqual(before.summary);

    // invoice-match-review §11: the report reflects the decision immediately.
    expect(await confirmCandidate(scope, needsReview.id, invoice.id)).toEqual({ resolved: true });
    const confirmed = await missingInvoiceReport(scope, "all");
    expect(confirmed.summary).toMatchObject({ documentsRequired: 5, matched: 2, needsReview: 0 });
    expect(confirmed.queue).toHaveLength(2);
    expectSumHolds(confirmed);

    expect(await markNotRequired(scope, notFound.id, "THIS_PAYMENT")).toEqual({ resolved: true });
    const dismissed = await missingInvoiceReport(scope, "all");
    expect(dismissed.summary).toMatchObject({ documentsRequired: 4, notRequired: 2, notFound: 0 });
    expect(dismissed.queue.map((row) => row.requirement.state)).toEqual(["IDENTIFIED"]);
    expectSumHolds(dismissed);
  });

  it("returns a rejected requirement to not found", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id, "NEEDS_REVIEW");
    await proposeInvoice(txn.id);

    await rejectAllCandidates(scope, requirement.id);
    const report = await missingInvoiceReport(scope, "not-found");

    expect(report.summary).toMatchObject({ notFound: 1, needsReview: 0, documentsRequired: 1 });
    expect(report.queue.map((row) => row.requirement.id)).toEqual([requirement.id]);
  });

  it("never lists a resolved or blocked requirement, whatever the filter", async () => {
    const resolved = await insertRequirement(
      (await insertTransaction()).id,
      "RESOLVED",
      "USER_LINKED",
    );
    const blocked = await insertRequirement((await insertTransaction()).id, "BLOCKED");

    for (const filter of ["all", "not-found", "needs-review", "waiting"] as const) {
      const ids = (await missingInvoiceReport(scope, filter)).queue.map((r) => r.requirement.id);
      expect(ids).not.toContain(resolved.id);
      expect(ids).not.toContain(blocked.id);
    }
  });

  it("does not list transactions that carry no requirement", async () => {
    await insertTransaction();
    await insertTransaction("CREDIT");

    const report = await missingInvoiceReport(scope, "all");

    expect(report.transactionsProcessed).toBe(2);
    expect(report.summary.documentsRequired).toBe(0);
    expect(report.queue).toEqual([]);
  });

  it("carries each row's transaction and the currency of its account", async () => {
    const txn = await insertTransaction();
    await insertRequirement(txn.id, "NOT_FOUND");

    const [row] = (await missingInvoiceReport(scope, "all")).queue;

    expect(row.transaction.id).toBe(txn.id);
    expect(row.transaction.amountMinor).toBe(txn.amountMinor);
    expect(row.accountCurrency).toBe("INR");
  });

  it("describes the latest run", async () => {
    await h.db.insert(reconciliationRuns).values([
      { workspaceId, state: "COMPLETED", startedAt: new Date("2026-09-01T00:00:00Z") },
      { workspaceId, state: "RUNNING", startedAt: new Date("2026-09-20T00:00:00Z") },
      { workspaceId, state: "FAILED", startedAt: new Date("2026-09-10T00:00:00Z") },
    ]);

    expect((await missingInvoiceReport(scope, "all")).run?.state).toBe("RUNNING");
  });

  it("has no run, no accounts and nothing to count in an empty workspace", async () => {
    const report = await missingInvoiceReport(scope, "all");

    expect(report.run).toBeNull();
    expect(report.accounts).toEqual([]);
    expect(report.transactionsProcessed).toBe(0);
    expect(report.summary.documentsRequired).toBe(0);
  });

  it("names only the accounts with a completed statement", async () => {
    const [other] = await h.db
      .insert(bankAccounts)
      .values({ workspaceId, bankName: "SBI", accountIdentifier: "XXXX9876", currency: "INR" })
      .returning();
    await insertStatement("COMPLETED");
    await insertStatement("FAILED", other.id);

    const report = await missingInvoiceReport(scope, "all");

    expect(report.accounts.map((account) => account.id)).toEqual([bankAccountId]);
  });

  it("counts only the clarification questions still open", async () => {
    await h.db.insert(clarificationQuestions).values([
      { workspaceId, question: "What was this?" },
      { workspaceId, question: "And this?", answer: "Rent", answeredAt: new Date() },
    ]);

    expect((await missingInvoiceReport(scope, "all")).openQuestions).toBe(1);
  });
});
