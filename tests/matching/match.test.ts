/**
 * Matching one invoice, end to end against a real database and a fake model.
 *
 * spec: docs/workflows/manual-invoice-upload.md §8-§10, §14 ·
 * docs/workflows/invoice-match-review.md §6
 *
 * The model is injected. Where a test asserts matching was skipped, the stub throws if it
 * is called — a skip that quietly still ran the pipeline would otherwise pass.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  canonicalTransactions,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  supportingDocuments,
  vendorAliases,
  vendors,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import type { AdjudicateMatch, JudgeSameInvoice } from "../../src/matching/contracts";
import { matchInvoice, type MatchDeps } from "../../src/matching/match";

let h: TestDb;
let scope: WorkspaceScope;
let workspaceId: string;
let bankAccountId: string;
let vendorId: string;

beforeEach(async () => {
  h = await createTestDb();
  const { workspace, user } = await seedWorkspace(h.db);
  workspaceId = workspace.id;
  bankAccountId = (await seedBankAccount(h.db, workspaceId)).id;
  scope = new WorkspaceScope(h.db, workspaceId, user.id);

  const [vendor] = await h.db
    .insert(vendors)
    .values({ workspaceId, name: "Anthropic" })
    .returning();
  vendorId = vendor.id;
  await h.db.insert(vendorAliases).values({
    workspaceId,
    vendorId,
    alias: "ANTHROPIC",
    aliasNormalized: "anthropic",
    confirmed: true,
  });
});

afterEach(async () => {
  await h.close();
});

const agrees: AdjudicateMatch = async () => ({
  ok: true,
  value: { candidate: 0, verdict: "SAME", reason: "Same vendor and amount" },
});

const unsure: AdjudicateMatch = async () => ({
  ok: true,
  value: { candidate: 0, verdict: "UNSURE", reason: "Two payments are equally close" },
});

const cannotAnswer: AdjudicateMatch = async () => ({ ok: false, reason: "schema rejected" });

const neverAsked: AdjudicateMatch = async () => {
  throw new Error("the model was consulted when matching should have been skipped");
};

const notDuplicate: JudgeSameInvoice = async () => ({
  ok: true,
  value: { same: "NO", reason: "different invoices" },
});

function deps(adjudicate: AdjudicateMatch, judge: JudgeSameInvoice = notDuplicate): MatchDeps {
  return {
    adjudicate,
    judgeSameInvoice: judge,
    formatAmount: (minor, currency) => (minor === null ? null : `${currency} ${minor}`),
  };
}

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

/** An invoice with its primary document, as understand.ts leaves them. */
async function insertInvoice(overrides: Record<string, unknown> = {}) {
  const [document] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "documents/x.pdf",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      source: "MANUAL_UPLOAD",
      state: "EXTRACTED",
    })
    .returning();

  const [invoice] = await h.db
    .insert(invoices)
    .values({
      workspaceId,
      vendorId,
      invoiceNumber: "INV-92831",
      invoiceDate: "2026-04-14",
      totalMinor: 2000n,
      currency: "USD",
      ...overrides,
    })
    .returning();

  await h.db
    .insert(invoiceDocuments)
    .values({ workspaceId, invoiceId: invoice.id, documentId: document.id, isPrimary: true });

  return { invoice, document };
}

describe("an invoice with one obvious payment", () => {
  it("links it and resolves the requirement", async () => {
    const txn = await insertTransaction();
    await h.db.insert(invoiceRequirements).values({ workspaceId, canonicalTransactionId: txn.id });
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(scope, invoice.id, deps(agrees));

    expect(outcome.outcome).toBe("LINKED");
    expect(outcome.transactionId).toBe(txn.id);

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.state).toBe("RESOLVED");
    expect(requirement.resolutionMethod).toBe("AUTO_MATCHED");
  });

  it("links a payment nothing asked about", async () => {
    // §14: an upload with no requirement still creates the Invoice and may be linked.
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(scope, invoice.id, deps(agrees));

    expect(outcome.outcome).toBe("LINKED");
    expect(outcome.transactionId).toBe(txn.id);
    expect(await h.db.select().from(invoiceRequirements)).toHaveLength(0);
  });

  it("gives the reason as the evidence, not a score", async () => {
    await insertTransaction();
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(scope, invoice.id, deps(agrees));

    expect(outcome.reason).toContain("Amount matches exactly");
    expect(outcome.reason).not.toMatch(/\d+%/);
  });
});

describe("an invoice the system will not decide alone", () => {
  it("asks when the model is unsure", async () => {
    const txn = await insertTransaction();
    await h.db.insert(invoiceRequirements).values({ workspaceId, canonicalTransactionId: txn.id });
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(scope, invoice.id, deps(unsure));

    expect(outcome.outcome).toBe("NEEDS_REVIEW");

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.state).toBe("NEEDS_REVIEW");
    expect(requirement.resolutionMethod).toBeNull();
  });

  it("asks when the model could not be reached", async () => {
    // A gateway with no credit is not agreement, and it is not a failed invoice either.
    await insertTransaction();
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(scope, invoice.id, deps(cannotAnswer));

    expect(outcome.outcome).toBe("NEEDS_REVIEW");
    const [row] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(row.canonicalTransactionId).toBeNull();
  });

  it("keeps the candidates it weighed, with their evidence", async () => {
    // Feature H renders these days later. Recomputing would mean deriving Stage 1 twice.
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();

    await matchInvoice(scope, invoice.id, deps(unsure));

    const [candidate] = await h.db.select().from(invoiceMatchCandidates);
    expect(candidate.canonicalTransactionId).toBe(txn.id);
    expect(candidate.modelVerdict).toBe("UNSURE");
    expect(Array.isArray(candidate.evidence)).toBe(true);
  });
});

describe("an invoice with nothing to match", () => {
  it("says so rather than asking about nothing", async () => {
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(scope, invoice.id, deps(agrees));

    expect(outcome.outcome).toBe("NOT_FOUND");
    expect(outcome.candidates).toBe(0);
  });

  it("writes no candidate rows", async () => {
    await insertInvoice();
    const { invoice } = await insertInvoice();

    await matchInvoice(scope, invoice.id, deps(agrees));

    expect(await h.db.select().from(invoiceMatchCandidates)).toHaveLength(0);
  });
});

describe("a document the user already told us about", () => {
  it("skips matching entirely", async () => {
    // invoice-match-review.md §6, and phase-1.md §7 G's completion bar. The stub throws
    // if consulted, so a skip that quietly still ran the pipeline fails here.
    const chosen = await insertTransaction({ occurrenceIndex: 0 });
    const other = await insertTransaction({ occurrenceIndex: 1, amountMinor: 2000n });
    await h.db
      .insert(invoiceRequirements)
      .values({ workspaceId, canonicalTransactionId: chosen.id });

    const { invoice, document } = await insertInvoice();
    await h.db
      .update(supportingDocuments)
      .set({ canonicalTransactionId: chosen.id })
      .where(eq(supportingDocuments.id, document.id));

    const outcome = await matchInvoice(scope, invoice.id, deps(neverAsked));

    expect(outcome.outcome).toBe("LINKED");
    expect(outcome.transactionId).toBe(chosen.id);
    expect(outcome.transactionId).not.toBe(other.id);
  });

  it("writes no candidates at all", async () => {
    const chosen = await insertTransaction();
    const { invoice, document } = await insertInvoice();
    await h.db
      .update(supportingDocuments)
      .set({ canonicalTransactionId: chosen.id })
      .where(eq(supportingDocuments.id, document.id));

    await matchInvoice(scope, invoice.id, deps(neverAsked));

    expect(await h.db.select().from(invoiceMatchCandidates)).toHaveLength(0);
  });

  it("records the user as the one who linked it", async () => {
    const chosen = await insertTransaction();
    await h.db
      .insert(invoiceRequirements)
      .values({ workspaceId, canonicalTransactionId: chosen.id });
    const { invoice, document } = await insertInvoice();
    await h.db
      .update(supportingDocuments)
      .set({ canonicalTransactionId: chosen.id })
      .where(eq(supportingDocuments.id, document.id));

    await matchInvoice(scope, invoice.id, deps(neverAsked));

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.resolutionMethod).toBe("USER_LINKED");
  });
});

describe("an invoice we may already have", () => {
  it("is never linked automatically, however good the evidence", async () => {
    await insertTransaction();
    await insertInvoice();
    const { invoice: copy } = await insertInvoice();

    const outcome = await matchInvoice(scope, copy.id, deps(agrees));

    expect(outcome.outcome).toBe("DUPLICATE");
    const [row] = await h.db.select().from(invoices).where(eq(invoices.id, copy.id));
    expect(row.canonicalTransactionId).toBeNull();
    expect(row.suspectedDuplicateOfInvoiceId).not.toBeNull();
  });
});

describe("running it twice", () => {
  it("leaves a linked invoice alone", async () => {
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();

    await matchInvoice(scope, invoice.id, deps(agrees));
    const again = await matchInvoice(scope, invoice.id, deps(neverAsked));

    expect(again.outcome).toBe("LINKED");
    expect(again.transactionId).toBe(txn.id);
  });

  it("does not double the candidate set", async () => {
    // A run that died after writing candidates and was retried.
    await insertTransaction();
    const { invoice } = await insertInvoice();

    await matchInvoice(scope, invoice.id, deps(unsure));
    await matchInvoice(scope, invoice.id, deps(unsure));

    expect(await h.db.select().from(invoiceMatchCandidates)).toHaveLength(1);
  });

  it("does not reopen a requirement the user resolved", async () => {
    const txn = await insertTransaction();
    await h.db.insert(invoiceRequirements).values({
      workspaceId,
      canonicalTransactionId: txn.id,
      state: "RESOLVED",
      resolutionMethod: "NOT_REQUIRED",
    });
    const { invoice } = await insertInvoice();

    await matchInvoice(scope, invoice.id, deps(unsure));

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.state).toBe("RESOLVED");
    expect(requirement.resolutionMethod).toBe("NOT_REQUIRED");
  });
});

describe("an invoice that is not yours", () => {
  it("behaves exactly as if it did not exist", async () => {
    const other = await seedWorkspace(h.db, "Attacker Business");
    const attacker = new WorkspaceScope(h.db, other.workspace.id, other.user.id);
    await insertTransaction();
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(attacker, invoice.id, deps(neverAsked));

    expect(outcome.outcome).toBe("SKIPPED");
    const [row] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(row.canonicalTransactionId).toBeNull();
  });
});

describe("the requirements a run is entitled to touch", () => {
  /**
   * spec: docs/state-machines.md §2 · docs/workflows/invoice-match-review.md §11
   *
   * One upload is one decision about one document. Marking every candidate's requirement
   * makes the action queue say five things need attention when one does, and resolving
   * the right one leaves four false alarms the user has to dismiss by hand.
   */
  it("marks only the requirement it is actually proposing", async () => {
    const anchor = await insertTransaction({ occurrenceIndex: 0 });
    const alsoNearby = await insertTransaction({ occurrenceIndex: 1 });
    await h.db.insert(invoiceRequirements).values([
      { workspaceId, canonicalTransactionId: anchor.id },
      { workspaceId, canonicalTransactionId: alsoNearby.id },
    ]);
    const { invoice } = await insertInvoice();

    await matchInvoice(scope, invoice.id, deps(unsure));

    const states = (await h.db.select().from(invoiceRequirements)).map((row) => row.state);

    // Which of two equally good candidates anchors the run is decided by the id tie-break
    // in `candidates.ts`, so the count is the assertion and the identity is not. One row
    // is in the queue; the other was never assessed and saying otherwise would put a row
    // there that nothing is waiting on.
    expect(states.filter((state) => state === "NEEDS_REVIEW")).toHaveLength(1);
    expect(states.filter((state) => state === "IDENTIFIED")).toHaveLength(1);
    expect(anchor.id).not.toBe(alsoNearby.id);
  });

  it("leaves nothing in EVALUATING, whatever the outcome", async () => {
    // EVALUATING means "candidates are being assessed". A run that has returned is not
    // assessing anything, and the action queue shows neither EVALUATING nor IDENTIFIED
    // as needing review -- so a stranded requirement is a payment that silently stops
    // being anybody's problem.
    let occurrence = 0;
    for (const adjudicator of [agrees, unsure, cannotAnswer]) {
      occurrence += 1;
      const txn = await insertTransaction({ occurrenceIndex: occurrence });
      await h.db
        .insert(invoiceRequirements)
        .values({ workspaceId, canonicalTransactionId: txn.id });
      const { invoice } = await insertInvoice();

      await matchInvoice(scope, invoice.id, deps(adjudicator));
    }

    const rows = await h.db.select().from(invoiceRequirements);
    expect(rows.filter((row) => row.state === "EVALUATING")).toEqual([]);
  });

  it("puts the requirement back where it found it when the run fails", async () => {
    // A provider timeout is not a verdict. Inngest retries, and the retry must start from
    // the state the first attempt inherited rather than from a state no screen renders.
    const txn = await insertTransaction();
    await h.db.insert(invoiceRequirements).values({ workspaceId, canonicalTransactionId: txn.id });
    const { invoice } = await insertInvoice();

    const explodes: AdjudicateMatch = async () => {
      throw new Error("gateway timed out");
    };

    await expect(matchInvoice(scope, invoice.id, deps(explodes))).rejects.toThrow(
      "gateway timed out",
    );

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.state).toBe("IDENTIFIED");
  });

  it("does not report a transaction it merely passed near as not found", async () => {
    // NOT_FOUND means "assessment completed and nothing suitable was established for this
    // transaction". Nothing was assessed for a transaction no candidate named.
    const nearby = await insertTransaction({
      amountMinor: 999999n,
      description: "ELECTRICITY BOARD",
      descriptionNormalized: "electricity board",
    });
    await h.db
      .insert(invoiceRequirements)
      .values({ workspaceId, canonicalTransactionId: nearby.id });
    const { invoice } = await insertInvoice();

    const outcome = await matchInvoice(scope, invoice.id, deps(agrees));

    expect(outcome.outcome).toBe("NOT_FOUND");
    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.state).toBe("IDENTIFIED");
  });
});
