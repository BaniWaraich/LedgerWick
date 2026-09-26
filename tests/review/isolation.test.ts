/**
 * Reviewing a requirement that is not yours.
 *
 * spec: docs/domain-model.md Rule 1, invariant 2 · docs/architecture.md §5.2, §19
 * required by docs/definition-of-done.md, "When it touches workspace-scoped data".
 *
 * Written as attacks rather than as assertions about filters, for the reason
 * `tests/documents/isolation.test.ts` gives: a filter can be present and wrong, and only
 * an attempt proves otherwise.
 *
 * Review writes to five scoped tables — `invoice_requirements`, `invoices`,
 * `invoice_documents`, `vendor_aliases` and `business_knowledge` — so there are five ways
 * for it to leak, and reads from four more. Every exported function is attacked below.
 *
 * The bar throughout is that an attacker cannot tell a row that exists from one that does
 * not, which is the choice `WorkspaceAccessError` already made for workspaces themselves.
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
  vendorAliases,
  vendors,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { candidateDocumentIds, linkableDocuments, reviewContext } from "../../src/review/context";
import { keepBoth, keepOne } from "../../src/review/duplicates";
import { confirmVendorAlias } from "../../src/review/learning";
import {
  confirmCandidate,
  linkExistingDocument,
  markNotRequired,
  rejectAllCandidates,
} from "../../src/review/resolve";

let h: TestDb;

const INVENTED = "11111111-1111-4111-8111-111111111111";

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
      description: "RAZORPAY*SECRETVENDOR",
      descriptionNormalized: "razorpay secretvendor",
      occurrenceIndex: 0,
    })
    .returning();

  const [vendor] = await h.db
    .insert(vendors)
    .values({ workspaceId, name: "Secret Vendor" })
    .returning();

  const [document] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "workspaces/victim/documents/private.pdf",
      filename: "private-invoice.pdf",
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
      invoiceNumber: "INV-SECRET",
      invoiceDate: "2026-04-14",
      totalMinor: 2000n,
      currency: "USD",
    })
    .returning();

  await h.db
    .insert(invoiceDocuments)
    .values({ workspaceId, invoiceId: invoice.id, documentId: document.id, isPrimary: true });

  await h.db.insert(invoiceMatchCandidates).values({
    workspaceId,
    invoiceId: invoice.id,
    canonicalTransactionId: transaction.id,
    rank: 0,
    evidence: [],
  });

  const [requirement] = await h.db
    .insert(invoiceRequirements)
    .values({
      workspaceId,
      canonicalTransactionId: transaction.id,
      state: "NEEDS_REVIEW",
      vendorGuess: "Secret Vendor",
    })
    .returning();

  return { victim, attacker, workspaceId, transaction, vendor, document, invoice, requirement };
}

beforeEach(async () => {
  h = await createTestDb();
});

afterEach(async () => {
  await h.close();
});

describe("reading a review that is not yours", () => {
  it("answers exactly as it does for a requirement that never existed", async () => {
    const { attacker, requirement } = await twoWorkspaces();

    const theirs = await reviewContext(attacker, requirement.id);
    const invented = await reviewContext(attacker, INVENTED);

    expect(theirs).toBeNull();
    expect(invented).toBeNull();
  });

  it("leaks no document, no vendor and no storage key", async () => {
    const { attacker, transaction, document } = await twoWorkspaces();

    const ids = await candidateDocumentIds(attacker, {
      id: INVENTED,
      canonicalTransactionId: transaction.id,
    });
    const linkable = await linkableDocuments(attacker);

    expect(ids).toEqual([]);
    expect(linkable).toEqual([]);
    expect(JSON.stringify(linkable)).not.toContain(document.storageRef);
  });
});

describe("resolving a requirement that is not yours", () => {
  it("cannot confirm a candidate", async () => {
    const { attacker, requirement, invoice } = await twoWorkspaces();

    expect((await confirmCandidate(attacker, requirement.id, invoice.id)).resolved).toBe(false);

    const [untouched] = await h.db
      .select()
      .from(invoiceRequirements)
      .where(eq(invoiceRequirements.id, requirement.id));
    expect(untouched.state).toBe("NEEDS_REVIEW");
    expect(untouched.resolutionMethod).toBeNull();

    const [unlinked] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(unlinked.canonicalTransactionId).toBeNull();
  });

  it("cannot link the victim's document to the victim's payment", async () => {
    const { attacker, requirement, document } = await twoWorkspaces();

    expect((await linkExistingDocument(attacker, requirement.id, document.id)).resolved).toBe(
      false,
    );

    const [untouched] = await h.db
      .select()
      .from(supportingDocuments)
      .where(eq(supportingDocuments.id, document.id));
    expect(untouched.canonicalTransactionId).toBeNull();
  });

  it("cannot record a rejection", async () => {
    const { attacker, requirement } = await twoWorkspaces();

    expect((await rejectAllCandidates(attacker, requirement.id)).resolved).toBe(false);

    const [untouched] = await h.db
      .select()
      .from(invoiceRequirements)
      .where(eq(invoiceRequirements.id, requirement.id));
    expect(untouched.rejectedDocumentIds).toEqual([]);
    expect(untouched.state).toBe("NEEDS_REVIEW");
  });

  it("cannot mark it as needing no document", async () => {
    const { attacker, requirement } = await twoWorkspaces();

    expect((await markNotRequired(attacker, requirement.id, "THIS_PAYMENT")).resolved).toBe(false);

    const [untouched] = await h.db
      .select()
      .from(invoiceRequirements)
      .where(eq(invoiceRequirements.id, requirement.id));
    expect(untouched.resolutionMethod).toBeNull();
  });

  it("writes no fact into either workspace when it tries to generalize", async () => {
    /*
     * The subtle one. A leak here does not move the victim's requirement -- it derives a
     * fact in the *attacker's* workspace from the victim's vendor, which would tell them
     * who the victim pays. Both sides are asserted for that reason.
     */
    const { attacker, requirement } = await twoWorkspaces();

    await markNotRequired(attacker, requirement.id, "THIS_VENDOR");

    expect(await h.db.select().from(businessKnowledge)).toEqual([]);
  });

  it("gives the same answer for a requirement that never existed", async () => {
    const { attacker, requirement, invoice } = await twoWorkspaces();

    expect(await confirmCandidate(attacker, requirement.id, invoice.id)).toEqual(
      await confirmCandidate(attacker, INVENTED, invoice.id),
    );
  });
});

describe("learning from someone else's confirmation", () => {
  it("writes the alias into the attacker's own workspace, never the victim's", async () => {
    // confirmVendorAlias takes ids the caller supplies, so the scope is the only thing
    // standing between an attacker and an alias on the victim's vendor.
    const { attacker, vendor, transaction } = await twoWorkspaces();

    await confirmVendorAlias(attacker, vendor.id, transaction.description);

    const onVictimsVendor = await h.db
      .select()
      .from(vendorAliases)
      .where(eq(vendorAliases.vendorId, vendor.id));
    expect(onVictimsVendor).toEqual([]);
  });
});

describe("merging invoices that are not yours", () => {
  it("cannot keep one", async () => {
    const { attacker, workspaceId, invoice, document } = await twoWorkspaces();
    const [copy] = await h.db
      .insert(invoices)
      .values({
        workspaceId,
        invoiceNumber: "INV-SECRET",
        suspectedDuplicateOfInvoiceId: invoice.id,
      })
      .returning();

    expect((await keepOne(attacker, copy.id, document.id)).merged).toBe(false);

    // Both records and both joins exactly where they were.
    expect(await h.db.select().from(invoices)).toHaveLength(2);
    expect(await h.db.select().from(invoiceDocuments)).toHaveLength(1);
  });

  it("cannot separate them", async () => {
    const { attacker, workspaceId, invoice } = await twoWorkspaces();
    const [copy] = await h.db
      .insert(invoices)
      .values({
        workspaceId,
        invoiceNumber: "INV-SECRET",
        suspectedDuplicateOfInvoiceId: invoice.id,
      })
      .returning();

    expect((await keepBoth(attacker, copy.id)).merged).toBe(false);

    const [untouched] = await h.db.select().from(invoices).where(eq(invoices.id, copy.id));
    expect(untouched.suspectedDuplicateOfInvoiceId).toBe(invoice.id);
  });
});

describe("a requirement of the attacker's own", () => {
  it("does not pick up the victim's candidates along the way", async () => {
    // The attacker has a legitimate requirement. Nothing about that should reach across
    // the boundary, even though the tables are shared.
    const { attacker, victim } = await twoWorkspaces();

    const account = await seedBankAccount(h.db, attacker.workspaceId);
    const [theirTransaction] = await h.db
      .insert(canonicalTransactions)
      .values({
        workspaceId: attacker.workspaceId,
        bankAccountId: account.id,
        valueDate: "2026-04-14",
        amountMinor: 2000n,
        direction: "DEBIT",
        currency: "USD",
        description: "RAZORPAY*SECRETVENDOR",
        descriptionNormalized: "razorpay secretvendor",
        occurrenceIndex: 0,
      })
      .returning();

    const [theirRequirement] = await h.db
      .insert(invoiceRequirements)
      .values({
        workspaceId: attacker.workspaceId,
        canonicalTransactionId: theirTransaction.id,
        state: "NEEDS_REVIEW",
      })
      .returning();

    const context = await reviewContext(attacker, theirRequirement.id);

    expect(context).not.toBeNull();
    expect(context?.candidates).toEqual([]);
    expect(context?.whatWeDid.candidatesConsidered).toBe(0);
    // And the victim still sees their own.
    expect(await victim.select(invoiceMatchCandidates)).toHaveLength(1);
  });
});
