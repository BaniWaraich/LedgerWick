/**
 * What confirming a match teaches, and the loop it closes.
 *
 * spec: docs/workflows/invoice-match-review.md §9 · docs/architecture.md §11
 *
 * The last test in this file is the point of the feature: a match the user had to make by
 * hand becomes one the system can make for them next time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  canonicalTransactions,
  invoiceDocuments,
  invoiceRequirements,
  invoices,
  supportingDocuments,
  vendorAliases,
  vendors,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { generateCandidates } from "../../src/matching/candidates";
import { confirmCandidate } from "../../src/review/resolve";
import { confirmVendorAlias } from "../../src/review/learning";

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
  const [vendor] = await h.db.insert(vendors).values({ workspaceId, name: "Adobe" }).returning();
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
      description: "RAZORPAY*ADOBE",
      descriptionNormalized: "razorpay adobe",
      occurrenceIndex: 0,
      ...overrides,
    })
    .returning();
  return row;
}

async function insertInvoice(overrides: Record<string, unknown> = {}) {
  const [document] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "documents/x.pdf",
      filename: "Receipt.pdf",
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
      invoiceNumber: "INV-1",
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

describe("the name a confirmation teaches", () => {
  it("is the payee, not the payment processor", async () => {
    // §9's own warning: "One user confirming an Adobe receipt does not establish that
    // every RAZORPAY* transaction is Adobe." normalizeVendorName strips the processor
    // before anything else, so the alias written is the thing the user actually confirmed.
    await confirmVendorAlias(scope, vendorId, "RAZORPAY*ADOBE");

    const [alias] = await h.db.select().from(vendorAliases);
    expect(alias.aliasNormalized).toBe("adobe");
    expect(alias.aliasNormalized).not.toContain("razorpay");
    // What the bank printed is kept as printed; the key is never shown to anyone.
    expect(alias.alias).toBe("RAZORPAY*ADOBE");
    expect(alias.confirmed).toBe(true);
  });

  it("is marked confirmed, not inferred", async () => {
    // architecture.md §11: AI inference is a suggestion, user confirmation is
    // authoritative. resolveVendor writes confirmed: false, always. This is the only
    // place a true gets written.
    await confirmVendorAlias(scope, vendorId, "ADOBE SYSTEMS");

    expect((await h.db.select().from(vendorAliases))[0].confirmed).toBe(true);
  });

  it("promotes an alias the extraction had only guessed", async () => {
    await h.db.insert(vendorAliases).values({
      workspaceId,
      vendorId,
      alias: "ADOBE",
      aliasNormalized: "adobe",
      confirmed: false,
    });

    expect(await confirmVendorAlias(scope, vendorId, "RAZORPAY*ADOBE")).toEqual({
      learned: true,
    });

    const rows = await h.db.select().from(vendorAliases);
    expect(rows).toHaveLength(1);
    expect(rows[0].confirmed).toBe(true);
  });

  it("teaches nothing twice", async () => {
    await confirmVendorAlias(scope, vendorId, "RAZORPAY*ADOBE");

    expect(await confirmVendorAlias(scope, vendorId, "RAZORPAY*ADOBE")).toEqual({
      learned: false,
    });
    expect(await h.db.select().from(vendorAliases)).toHaveLength(1);
  });

  it("teaches nothing when the description named nobody", async () => {
    // A narration that was a reference number and nothing else.
    expect(await confirmVendorAlias(scope, vendorId, "UPI/9876543210/")).toEqual({
      learned: false,
    });
    expect(await h.db.select().from(vendorAliases)).toHaveLength(0);
  });

  it("teaches nothing when the invoice never resolved a vendor", async () => {
    expect(await confirmVendorAlias(scope, null, "RAZORPAY*ADOBE")).toEqual({ learned: false });
  });

  it("leaves an alias another vendor already owns alone", async () => {
    // Confirming which document pays which payment is not a claim that two vendors are
    // one. That is a merge, and phase-1.md §3 defers the screen for it.
    const [other] = await h.db
      .insert(vendors)
      .values({ workspaceId, name: "Someone Else" })
      .returning();
    await h.db.insert(vendorAliases).values({
      workspaceId,
      vendorId: other.id,
      alias: "ADOBE",
      aliasNormalized: "adobe",
      confirmed: true,
    });

    expect(await confirmVendorAlias(scope, vendorId, "RAZORPAY*ADOBE")).toEqual({
      learned: false,
    });

    const rows = await h.db.select().from(vendorAliases);
    expect(rows).toHaveLength(1);
    expect(rows[0].vendorId).toBe(other.id);
  });
});

describe("confirming a candidate", () => {
  it("records the alias once the link has actually taken effect", async () => {
    const txn = await insertTransaction();
    const [requirement] = await h.db
      .insert(invoiceRequirements)
      .values({ workspaceId, canonicalTransactionId: txn.id, state: "NEEDS_REVIEW" })
      .returning();
    const { invoice } = await insertInvoice();

    await confirmCandidate(scope, requirement.id, invoice.id);

    const [alias] = await h.db.select().from(vendorAliases);
    expect(alias.aliasNormalized).toBe("adobe");
    expect(alias.confirmed).toBe(true);
  });

  it("teaches nothing when the confirmation lost the payment to a rival", async () => {
    // The user's decision did not take effect, so it taught nothing. Learning here would
    // record a fact from a decision the system refused.
    const txn = await insertTransaction();
    const [requirement] = await h.db
      .insert(invoiceRequirements)
      .values({ workspaceId, canonicalTransactionId: txn.id, state: "NEEDS_REVIEW" })
      .returning();
    const mine = await insertInvoice();
    const rival = await insertInvoice();
    await h.db
      .update(invoices)
      .set({ canonicalTransactionId: txn.id })
      .where(eq(invoices.id, rival.invoice.id));

    const outcome = await confirmCandidate(scope, requirement.id, mine.invoice.id);

    expect(outcome.resolved).toBe(false);
    expect(await h.db.select().from(vendorAliases)).toHaveLength(0);
  });
});

describe("the loop this closes", () => {
  it("turns a vendor the system could not recognise into one it can", async () => {
    /*
     * The point of the feature, end to end.
     *
     * `decide.ts` requires vendor evidence of RESOLVED or ALIAS before it will link
     * automatically -- NORMALIZED_CONTAINS and NONE are deliberately not enough. Before
     * the confirmation this description is NONE, so no future payment to this vendor
     * could ever auto-match. After it, the same description is a vendor the system knows.
     */
    const facts = {
      id: "irrelevant",
      documentId: null,
      invoiceNumber: "INV-2",
      invoiceDate: "2026-05-14",
      totalMinor: 2000n,
      currency: "USD",
      vendorId,
      vendorName: "Adobe",
      // The invoice says "Adobe"; the bank says "RAZORPAY*ADOBE 88213". Nothing links
      // them until somebody says so.
      vendorKeys: ["adobe"],
    };

    const nextMonth = await insertTransaction({
      valueDate: "2026-05-14",
      description: "RAZORPAY*ADOBE 88213",
      descriptionNormalized: "razorpay adobe 88213",
      occurrenceIndex: 1,
    });

    const before = await generateCandidates(scope, {
      ...facts,
      id: (await insertInvoice()).invoice.id,
    });
    const vendorBefore = before.candidates
      .find((c) => c.transaction.id === nextMonth.id)
      ?.evidence.find((e) => e.kind === "VENDOR");

    await confirmVendorAlias(scope, vendorId, "RAZORPAY*ADOBE 88213");

    const after = await generateCandidates(scope, {
      ...facts,
      id: (await insertInvoice()).invoice.id,
    });
    const vendorAfter = after.candidates
      .find((c) => c.transaction.id === nextMonth.id)
      ?.evidence.find((e) => e.kind === "VENDOR");

    expect(vendorBefore?.kind === "VENDOR" && vendorBefore.agreement).not.toBe("RESOLVED");
    expect(vendorAfter?.kind === "VENDOR" && vendorAfter.agreement).toBe("RESOLVED");
  });
});
