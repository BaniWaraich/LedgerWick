/**
 * Matching, from a workspace that has no business doing it.
 *
 * spec: docs/domain-model.md Rule 1, invariant 2 · docs/architecture.md §5.2, §19
 * required by docs/definition-of-done.md, "When it touches workspace-scoped data".
 *
 * Written as attacks rather than as assertions about filters, for the reason
 * `tests/documents/isolation.test.ts` gives: a filter can be present and wrong, and only
 * an attempt proves otherwise.
 *
 * Feature G writes to four scoped tables — `invoice_match_candidates`, `invoices`,
 * `invoice_requirements` and `supporting_documents` — so there are four ways for it to
 * leak, and reads from two more. Each is attacked below.
 *
 * The bar throughout is that an attacker cannot tell a row that exists from one that does
 * not. Distinguishing the two says which ids are real, which is the choice
 * `WorkspaceAccessError` already made for workspaces themselves.
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
import { generateCandidates } from "../../src/matching/candidates";
import { findDuplicate } from "../../src/matching/duplicates";
import { linkDocument, linkInvoice } from "../../src/matching/link";
import { matchInvoice, linkableTransactions } from "../../src/matching/match";

let h: TestDb;

/** The victim's workspace, fully populated, and an attacker holding nothing. */
async function twoWorkspaces() {
  const victimSeed = await seedWorkspace(h.db, "Victim Business");
  const attackerSeed = await seedWorkspace(h.db, "Attacker Business");

  const victim = new WorkspaceScope(h.db, victimSeed.workspace.id, victimSeed.user.id);
  const attacker = new WorkspaceScope(h.db, attackerSeed.workspace.id, attackerSeed.user.id);

  const workspaceId = victimSeed.workspace.id;
  const account = await seedBankAccount(h.db, workspaceId);

  const [transaction] = await h.db
    .insert(canonicalTransactions)
    .values({
      workspaceId,
      bankAccountId: account.id,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      direction: "DEBIT",
      currency: "USD",
      description: "ANTHROPIC",
      descriptionNormalized: "anthropic",
      occurrenceIndex: 0,
    })
    .returning();

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

  const [document] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "documents/secret.pdf",
      filename: "secret-invoice.pdf",
      mimeType: "application/pdf",
      source: "MANUAL_UPLOAD",
      state: "EXTRACTED",
    })
    .returning();

  const [invoice] = await h.db
    .insert(invoices)
    .values({
      workspaceId,
      vendorId: vendor.id,
      invoiceNumber: "INV-92831",
      invoiceDate: "2026-04-14",
      totalMinor: 2000n,
      currency: "USD",
    })
    .returning();

  await h.db
    .insert(invoiceDocuments)
    .values({ workspaceId, invoiceId: invoice.id, documentId: document.id, isPrimary: true });

  const [requirement] = await h.db
    .insert(invoiceRequirements)
    .values({ workspaceId, canonicalTransactionId: transaction.id })
    .returning();

  return { victim, attacker, workspaceId, transaction, invoice, document, requirement, vendor };
}

const neverAsked: AdjudicateMatch = async () => {
  throw new Error("a model was asked about another workspace's invoice");
};

const neverJudged: JudgeSameInvoice = async () => {
  throw new Error("a model was asked about another workspace's invoices");
};

const deps = {
  adjudicate: neverAsked,
  judgeSameInvoice: neverJudged,
  formatAmount: (minor: bigint | null, currency: string | null) =>
    minor === null ? null : `${currency} ${minor}`,
};

beforeEach(async () => {
  h = await createTestDb();
});

afterEach(async () => {
  await h.close();
});

describe("matching an invoice that is not yours", () => {
  it("refuses, and cannot tell the attacker the invoice exists", async () => {
    const { attacker, invoice } = await twoWorkspaces();

    const outcome = await matchInvoice(attacker, invoice.id, deps);

    // Identical to what a made-up id returns, deliberately.
    expect(outcome.outcome).toBe("SKIPPED");
    expect(outcome.transactionId).toBeNull();

    const invented = await matchInvoice(attacker, "11111111-1111-4111-8111-111111111111", deps);
    expect(invented).toEqual(outcome);
  });

  it("never sends another workspace's invoice to a model", async () => {
    // The stubs throw. A leak that reached the prompt would surface as a failure here
    // rather than as a passing test with a workspace's data in someone else's context.
    const { attacker, invoice } = await twoWorkspaces();

    await expect(matchInvoice(attacker, invoice.id, deps)).resolves.toBeDefined();
  });

  it("writes nothing into either workspace", async () => {
    const { attacker, invoice } = await twoWorkspaces();

    await matchInvoice(attacker, invoice.id, deps);

    expect(await h.db.select().from(invoiceMatchCandidates)).toHaveLength(0);

    const [untouched] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(untouched.canonicalTransactionId).toBeNull();
    expect(untouched.suspectedDuplicateOfInvoiceId).toBeNull();
  });

  it("leaves the victim's requirement exactly as it was", async () => {
    const { attacker, invoice, requirement } = await twoWorkspaces();

    await matchInvoice(attacker, invoice.id, deps);

    const [after] = await h.db
      .select()
      .from(invoiceRequirements)
      .where(eq(invoiceRequirements.id, requirement.id));

    expect(after.state).toBe("IDENTIFIED");
    expect(after.resolutionMethod).toBeNull();
  });
});

describe("proposing candidates across a boundary", () => {
  it("never offers another workspace's payments", async () => {
    const { attacker, invoice, transaction } = await twoWorkspaces();

    const { candidates } = await generateCandidates(attacker, {
      id: invoice.id,
      invoiceNumber: "INV-92831",
      invoiceDate: "2026-04-14",
      totalMinor: 2000n,
      currency: "USD",
      vendorId: null,
      vendorName: "Anthropic",
      vendorKeys: ["anthropic"],
    });

    expect(candidates).toHaveLength(0);
    expect(candidates.map((c) => c.transaction.id)).not.toContain(transaction.id);
  });

  it("never lists another workspace's payments as linkable", async () => {
    // This feeds the manual-link picker, so a leak here is another workspace's payments
    // rendered on a page with their descriptions and amounts.
    const { attacker, transaction } = await twoWorkspaces();

    const rows = await linkableTransactions(attacker);

    expect(rows.map((row) => row.id)).not.toContain(transaction.id);
  });

  it("never reads another workspace's stored candidates", async () => {
    const { victim, attacker, invoice, transaction, workspaceId } = await twoWorkspaces();
    await h.db.insert(invoiceMatchCandidates).values({
      workspaceId,
      invoiceId: invoice.id,
      canonicalTransactionId: transaction.id,
      rank: 0,
      evidence: [],
    });

    expect(await attacker.select(invoiceMatchCandidates)).toHaveLength(0);
    expect(await victim.select(invoiceMatchCandidates)).toHaveLength(1);
  });
});

describe("linking across a boundary", () => {
  it("cannot link the victim's invoice to anything", async () => {
    const { attacker, invoice, transaction } = await twoWorkspaces();

    const outcome = await linkInvoice(attacker, invoice.id, transaction.id, "USER_LINKED");

    expect(outcome.linked).toBe(false);

    const [untouched] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(untouched.canonicalTransactionId).toBeNull();
  });

  it("cannot link the victim's document to anything", async () => {
    const { attacker, document, transaction } = await twoWorkspaces();

    const outcome = await linkDocument(attacker, document.id, transaction.id, "USER_LINKED");

    expect(outcome.linked).toBe(false);

    const [untouched] = await h.db
      .select()
      .from(supportingDocuments)
      .where(eq(supportingDocuments.id, document.id));
    expect(untouched.canonicalTransactionId).toBeNull();
  });

  it("cannot resolve the victim's requirement by linking its own document", async () => {
    // The nastier shape: the attacker owns the document and aims it at a transaction id
    // they happen to know. The update is scoped, so nothing on the other side moves.
    const { attacker, transaction } = await twoWorkspaces();

    const [theirs] = await h.db
      .insert(supportingDocuments)
      .values({
        workspaceId: attacker.workspaceId,
        storageRef: "documents/mine.pdf",
        filename: "mine.pdf",
        mimeType: "application/pdf",
        source: "MANUAL_UPLOAD",
        state: "EXTRACTED",
      })
      .returning();

    await linkDocument(attacker, theirs.id, transaction.id, "USER_LINKED");

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.state).toBe("IDENTIFIED");
    expect(requirement.resolvedDocumentId).toBeNull();
  });
});

describe("comparing invoices across a boundary", () => {
  it("never finds another workspace's invoice as a duplicate", async () => {
    // The two workspaces each have an invoice from the same vendor, same number, same
    // amount, same day. Only a scoped comparison keeps them apart.
    const { attacker, vendor } = await twoWorkspaces();

    const [theirVendor] = await h.db
      .insert(vendors)
      .values({ workspaceId: attacker.workspaceId, name: "Anthropic" })
      .returning();

    const [theirs] = await h.db
      .insert(invoices)
      .values({
        workspaceId: attacker.workspaceId,
        vendorId: theirVendor.id,
        invoiceNumber: "INV-92831",
        invoiceDate: "2026-04-14",
        totalMinor: 2000n,
        currency: "USD",
      })
      .returning();

    const found = await findDuplicate(attacker, theirs, {
      judge: neverJudged,
      vendorName: "Anthropic",
    });

    expect(found).toBeNull();
    expect(vendor.id).not.toBe(theirVendor.id);
  });
});
