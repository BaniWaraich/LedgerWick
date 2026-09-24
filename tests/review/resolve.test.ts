/**
 * Applying the four decisions a user can make on one requirement.
 *
 * spec: docs/workflows/invoice-match-review.md §5, §6, §7, §9, §11
 *
 * Integration, because every one of these is a write and the thing worth checking is what
 * ended up in the row — the state, the method, and whether anything was learned.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  businessKnowledge,
  canonicalTransactions,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  supportingDocuments,
  vendors,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import {
  confirmCandidate,
  linkExistingDocument,
  markNotRequired,
  rejectAllCandidates,
} from "../../src/review/resolve";

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

async function insertRequirement(transactionId: string, overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
    .insert(invoiceRequirements)
    .values({
      workspaceId,
      canonicalTransactionId: transactionId,
      state: "NEEDS_REVIEW",
      vendorGuess: "Anthropic",
      ...overrides,
    })
    .returning();
  return row;
}

async function insertDocument(overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "documents/x.pdf",
      filename: "Receipt.pdf",
      mimeType: "application/pdf",
      source: "MANUAL_UPLOAD",
      state: "EXTRACTED",
      ...overrides,
    })
    .returning();
  return row;
}

/** An invoice with its primary document, as understand.ts leaves them. */
async function insertInvoice(overrides: Record<string, unknown> = {}) {
  const document = await insertDocument();
  const [invoice] = await h.db
    .insert(invoices)
    .values({ workspaceId, vendorId, totalMinor: 2000n, currency: "USD", ...overrides })
    .returning();
  await h.db
    .insert(invoiceDocuments)
    .values({ workspaceId, invoiceId: invoice.id, documentId: document.id, isPrimary: true });
  return { invoice, document };
}

async function proposeFor(transactionId: string, invoiceId: string, rank = 0) {
  await h.db.insert(invoiceMatchCandidates).values({
    workspaceId,
    invoiceId,
    canonicalTransactionId: transactionId,
    rank,
    evidence: [],
  });
}

const requirementRow = async (id: string) =>
  (await h.db.select().from(invoiceRequirements).where(eq(invoiceRequirements.id, id)))[0];

describe("choosing one of the candidates", () => {
  it("links it and resolves the requirement as the user's choice", async () => {
    // §5: "Choosing a candidate resolves the requirement with method USER_CONFIRMED."
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice, document } = await insertInvoice();
    await proposeFor(txn.id, invoice.id);

    expect(await confirmCandidate(scope, requirement.id, invoice.id)).toEqual({ resolved: true });

    const row = await requirementRow(requirement.id);
    expect(row.state).toBe("RESOLVED");
    expect(row.resolutionMethod).toBe("USER_CONFIRMED");
    expect(row.resolvedDocumentId).toBe(document.id);

    const [linked] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(linked.canonicalTransactionId).toBe(txn.id);
  });

  it("refuses when the payment was taken in the meantime", async () => {
    // A rival link written between the screen rendering and the button being pressed. The
    // user gets a sentence, not a stack trace.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const mine = await insertInvoice();
    const rival = await insertInvoice();
    await h.db
      .update(invoices)
      .set({ canonicalTransactionId: txn.id })
      .where(eq(invoices.id, rival.invoice.id));

    const outcome = await confirmCandidate(scope, requirement.id, mine.invoice.id);

    expect(outcome).toEqual({
      resolved: false,
      reason: "That payment already has an invoice.",
    });
  });

  it("does nothing the second time", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();

    await confirmCandidate(scope, requirement.id, invoice.id);
    const again = await confirmCandidate(scope, requirement.id, invoice.id);

    expect(again.resolved).toBe(false);
  });

  it("learns nothing about the business", async () => {
    // §9 puts the alias on this decision, and that is learning.ts's job. Nothing else is
    // learned here -- a confirmation is not a statement about whether the vendor needs
    // documents in future.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();

    await confirmCandidate(scope, requirement.id, invoice.id);

    expect(await h.db.select().from(businessKnowledge)).toHaveLength(0);
  });
});

describe("picking a document the workspace already has", () => {
  it("links through the invoice when the document became one", async () => {
    // domain-model.md §5.1: the one-to-one rule constrains extracted invoices. Linking
    // the document directly would leave the invoice unlinked, and the reconciliation
    // would show a payment with evidence but no invoice.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice, document } = await insertInvoice();

    expect(await linkExistingDocument(scope, requirement.id, document.id)).toEqual({
      resolved: true,
    });

    const [linked] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(linked.canonicalTransactionId).toBe(txn.id);
    expect((await requirementRow(requirement.id)).resolutionMethod).toBe("USER_CONFIRMED");
  });

  it("links a document that never became an invoice directly", async () => {
    // §5.1's second branch: a payment confirmation too thin to extract is still evidence.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const receipt = await insertDocument({ state: "UNREADABLE" });

    expect(await linkExistingDocument(scope, requirement.id, receipt.id)).toEqual({
      resolved: true,
    });

    const [row] = await h.db
      .select()
      .from(supportingDocuments)
      .where(eq(supportingDocuments.id, receipt.id));
    expect(row.canonicalTransactionId).toBe(txn.id);
    expect(await h.db.select().from(invoices)).toHaveLength(0);
  });

  it("lets the user pick a document they previously rejected", async () => {
    // Rejection suppresses what the system proposes. A user who overrules themselves is
    // allowed to -- §9: user confirmation is authoritative.
    const txn = await insertTransaction();
    const { invoice, document } = await insertInvoice();
    const requirement = await insertRequirement(txn.id, {
      state: "NOT_FOUND",
      rejectedDocumentIds: [document.id],
    });

    expect(await linkExistingDocument(scope, requirement.id, document.id)).toEqual({
      resolved: true,
    });

    const [linked] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(linked.canonicalTransactionId).toBe(txn.id);
  });
});

describe("saying none of these is right", () => {
  it("returns the requirement to the queue without resolving it", async () => {
    // §11: every path either resolves the requirement or returns it to the action queue.
    // This is the second kind, so resolutionMethod must stay null.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice, document } = await insertInvoice();
    await proposeFor(txn.id, invoice.id);

    expect(await rejectAllCandidates(scope, requirement.id)).toEqual({ resolved: true });

    const row = await requirementRow(requirement.id);
    expect(row.state).toBe("NOT_FOUND");
    expect(row.resolutionMethod).toBeNull();
    expect(row.rejectedDocumentIds).toEqual([document.id]);
  });

  it("records every candidate that was on the screen", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const first = await insertInvoice();
    const second = await insertInvoice();
    await proposeFor(txn.id, first.invoice.id, 0);
    await proposeFor(txn.id, second.invoice.id, 1);

    await rejectAllCandidates(scope, requirement.id);

    const row = await requirementRow(requirement.id);
    expect(row.rejectedDocumentIds).toHaveLength(2);
    expect(row.rejectedDocumentIds).toContain(first.document.id);
    expect(row.rejectedDocumentIds).toContain(second.document.id);
  });

  it("keeps the candidate rows", async () => {
    // §7: "Rejection is evidence. It should never be discarded." Deleting the rows the
    // user rejected would discard the record of what was proposed.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    await proposeFor(txn.id, invoice.id);

    await rejectAllCandidates(scope, requirement.id);

    expect(await h.db.select().from(invoiceMatchCandidates)).toHaveLength(1);
  });

  it("adds to an earlier rejection rather than replacing it", async () => {
    // A later run proposed something new and the user rejected that too. Both are on
    // record; forgetting the first would let it be proposed again.
    const txn = await insertTransaction();
    const old = await insertInvoice();
    const requirement = await insertRequirement(txn.id, {
      rejectedDocumentIds: [old.document.id],
    });
    const fresh = await insertInvoice();
    await proposeFor(txn.id, fresh.invoice.id);

    await rejectAllCandidates(scope, requirement.id);

    const row = await requirementRow(requirement.id);
    expect(row.rejectedDocumentIds).toEqual([old.document.id, fresh.document.id]);
  });

  it("does not record the same document twice", async () => {
    const txn = await insertTransaction();
    const { invoice, document } = await insertInvoice();
    const requirement = await insertRequirement(txn.id);
    await proposeFor(txn.id, invoice.id);

    await rejectAllCandidates(scope, requirement.id);
    await h.db
      .update(invoiceRequirements)
      .set({ state: "NEEDS_REVIEW" })
      .where(eq(invoiceRequirements.id, requirement.id));
    await rejectAllCandidates(scope, requirement.id);

    expect((await requirementRow(requirement.id)).rejectedDocumentIds).toEqual([document.id]);
  });

  it("refuses when there is nothing on the screen to reject", async () => {
    // A button that records an empty rejection and changes the state to the state it is
    // already in would be a lie about having done something.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id, { state: "NOT_FOUND" });

    expect(await rejectAllCandidates(scope, requirement.id)).toEqual({
      resolved: false,
      reason: "There is nothing here to reject.",
    });
  });

  it("learns nothing about the vendor", async () => {
    // §9 row 3: "Nothing about the vendor; only that these candidates were wrong."
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();
    await proposeFor(txn.id, invoice.id);

    await rejectAllCandidates(scope, requirement.id);

    expect(await h.db.select().from(businessKnowledge)).toHaveLength(0);
  });
});

describe("saying no document is needed", () => {
  it("resolves the requirement with nothing linked", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    expect(await markNotRequired(scope, requirement.id, "THIS_PAYMENT")).toEqual({
      resolved: true,
    });

    const row = await requirementRow(requirement.id);
    expect(row.state).toBe("RESOLVED");
    expect(row.resolutionMethod).toBe("NOT_REQUIRED");
    expect(row.resolvedDocumentId).toBeNull();
  });

  it("learns nothing when it is about this payment only", async () => {
    // §9's warning, honoured by asking rather than assuming. One odd payment to a vendor
    // the business normally does need invoices from must not teach a rule.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    await markNotRequired(scope, requirement.id, "THIS_PAYMENT");

    expect(await h.db.select().from(businessKnowledge)).toHaveLength(0);
  });

  it("writes one fact when it is about the vendor", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    await markNotRequired(scope, requirement.id, "THIS_VENDOR");

    const rows = await h.db.select().from(businessKnowledge);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("vendor");
    // The normalized payee, so two spellings of one vendor reach one fact.
    expect(rows[0].key).toBe("anthropic");
  });

  it("keys the fact on the payee, never on the narration", async () => {
    // Two payments to one vendor written by different rails must reach the same fact, or
    // the knowledge would be true of exactly one payment and never fire again.
    const first = await insertTransaction({ occurrenceIndex: 0 });
    const second = await insertTransaction({ occurrenceIndex: 1 });
    const a = await insertRequirement(first.id, { vendorGuess: "ANTHROPIC." });
    const b = await insertRequirement(second.id, { vendorGuess: "Anthropic" });

    await markNotRequired(scope, a.id, "THIS_VENDOR");
    await markNotRequired(scope, b.id, "THIS_VENDOR");

    expect(await h.db.select().from(businessKnowledge)).toHaveLength(1);
  });

  it("resolves but learns nothing when the narration named nobody", async () => {
    // The same split answer.ts makes: the question closes, and there is nothing to
    // generalize over.
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id, { vendorGuess: null });

    expect(await markNotRequired(scope, requirement.id, "THIS_VENDOR")).toEqual({
      resolved: true,
    });
    expect(await h.db.select().from(businessKnowledge)).toHaveLength(0);
  });

  it("does nothing the second time", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);

    await markNotRequired(scope, requirement.id, "THIS_VENDOR");
    const again = await markNotRequired(scope, requirement.id, "THIS_VENDOR");

    expect(again.resolved).toBe(false);
    expect(await h.db.select().from(businessKnowledge)).toHaveLength(1);
  });
});

describe("a requirement that is settled, absent, or not yours", () => {
  it("gives every decision the same answer", async () => {
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id, {
      state: "RESOLVED",
      resolutionMethod: "AUTO_MATCHED",
    });
    const { invoice, document } = await insertInvoice();

    const outcomes = [
      await confirmCandidate(scope, requirement.id, invoice.id),
      await linkExistingDocument(scope, requirement.id, document.id),
      await rejectAllCandidates(scope, requirement.id),
      await markNotRequired(scope, requirement.id, "THIS_VENDOR"),
    ];

    for (const outcome of outcomes) expect(outcome.resolved).toBe(false);
    // Untouched: a machine's decision is not overwritten by a stale form.
    expect((await requirementRow(requirement.id)).resolutionMethod).toBe("AUTO_MATCHED");
  });

  it("does not distinguish a stranger's requirement from one that never existed", async () => {
    const other = await seedWorkspace(h.db, "Attacker Business");
    const attacker = new WorkspaceScope(h.db, other.workspace.id, other.user.id);
    const txn = await insertTransaction();
    const requirement = await insertRequirement(txn.id);
    const { invoice } = await insertInvoice();

    const theirs = await confirmCandidate(attacker, requirement.id, invoice.id);
    const invented = await confirmCandidate(
      attacker,
      "11111111-1111-4111-8111-111111111111",
      invoice.id,
    );

    expect(theirs).toEqual(invented);
    expect((await requirementRow(requirement.id)).state).toBe("NEEDS_REVIEW");
  });
});
