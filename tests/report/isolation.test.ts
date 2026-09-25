/**
 * Reading a report that is not yours.
 *
 * spec: docs/domain-model.md Rule 1 · docs/architecture.md §5.2, §19
 * required by docs/definition-of-done.md, "When it touches workspace-scoped data".
 *
 * The report reads six scoped tables and writes none, so its leaks would all be reads: a
 * count that includes the victim's requirements, a queue row showing the victim's payment,
 * or the victim's run and accounts described as the attacker's. Each is attempted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  bankAccounts,
  bankStatements,
  canonicalTransactions,
  clarificationQuestions,
  invoiceRequirements,
  reconciliationRuns,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { missingInvoiceReport } from "../../src/report/report";
import { FILTERS } from "../../src/report/summary";

let h: TestDb;
let victim: WorkspaceScope;
let attacker: WorkspaceScope;

beforeEach(async () => {
  h = await createTestDb();
  const victimSeed = await seedWorkspace(h.db, "Victim Business");
  const attackerSeed = await seedWorkspace(h.db, "Attacker Business");
  victim = new WorkspaceScope(h.db, victimSeed.workspace.id, victimSeed.user.id);
  attacker = new WorkspaceScope(h.db, attackerSeed.workspace.id, attackerSeed.user.id);

  // The victim's workspace, with something in every line of the report.
  const workspaceId = victimSeed.workspace.id;
  const account = await seedBankAccount(h.db, workspaceId);

  await h.db.insert(bankStatements).values({
    workspaceId,
    bankAccountId: account.id,
    uploadBatchId: crypto.randomUUID(),
    filename: "statement.csv",
    mimeType: "text/csv",
    storageRef: "statements/x.csv",
    state: "COMPLETED",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
  });
  await h.db.insert(reconciliationRuns).values({ workspaceId, state: "COMPLETED" });
  await h.db.insert(clarificationQuestions).values({ workspaceId, question: "What was this?" });

  const states = ["NOT_FOUND", "NEEDS_REVIEW", "IDENTIFIED", "BLOCKED", "RESOLVED"] as const;
  for (const [i, state] of states.entries()) {
    const [transaction] = await h.db
      .insert(canonicalTransactions)
      .values({
        workspaceId,
        bankAccountId: account.id,
        valueDate: `2026-03-0${i + 1}`,
        amountMinor: 5000n,
        direction: "DEBIT",
        currency: "INR",
        description: `VICTIM PAYMENT ${i}`,
        descriptionNormalized: `victim payment ${i}`,
      })
      .returning();
    await h.db.insert(invoiceRequirements).values({
      workspaceId,
      canonicalTransactionId: transaction.id,
      state,
      resolutionMethod: state === "RESOLVED" ? "USER_LINKED" : null,
    });
  }
});

afterEach(async () => {
  await h.close();
});

describe("workspace isolation", () => {
  it("shows the attacker nothing of the victim's reconciliation", async () => {
    const report = await missingInvoiceReport(attacker, "all");

    expect(report.run).toBeNull();
    expect(report.accounts).toEqual([]);
    expect(report.transactionsProcessed).toBe(0);
    expect(report.openQuestions).toBe(0);
    expect(report.queue).toEqual([]);
    expect(report.summary).toEqual({
      documentsRequired: 0,
      matched: 0,
      notFound: 0,
      needsReview: 0,
      waiting: 0,
      blocked: 0,
      notRequired: 0,
    });
  });

  it("cannot widen the read with any filter", async () => {
    for (const filter of [...FILTERS, "all"] as const) {
      expect((await missingInvoiceReport(attacker, filter)).queue).toEqual([]);
    }
  });

  it("still shows the victim their own report", async () => {
    // Proves the attacker's empty report is isolation, not a report that reads nothing.
    const report = await missingInvoiceReport(victim, "all");

    expect(report.transactionsProcessed).toBe(5);
    expect(report.summary.documentsRequired).toBe(5);
    expect(report.queue).toHaveLength(3);
    expect(report.accounts).toHaveLength(1);
    expect(report.run).not.toBeNull();
    expect(report.openQuestions).toBe(1);
  });

  it("does not mix the two when both have data", async () => {
    const [account] = await attacker.insert(bankAccounts, {
      bankName: "SBI",
      accountIdentifier: "XXXX0001",
      currency: "INR",
    });
    const [transaction] = await attacker.insert(canonicalTransactions, {
      bankAccountId: account.id,
      valueDate: "2026-03-10",
      amountMinor: 700n,
      direction: "DEBIT",
      currency: "INR",
      description: "ATTACKER PAYMENT",
      descriptionNormalized: "attacker payment",
    });
    await attacker.insert(invoiceRequirements, {
      canonicalTransactionId: transaction.id,
      state: "NOT_FOUND",
    });

    const report = await missingInvoiceReport(attacker, "all");

    expect(report.transactionsProcessed).toBe(1);
    expect(report.summary.documentsRequired).toBe(1);
    expect(report.queue.map((row) => row.transaction.description)).toEqual(["ATTACKER PAYMENT"]);
  });
});
