/**
 * Attaching a document to a payment, and everything that must not happen when two try.
 *
 * spec: docs/domain-model.md invariants 8, 9 and 17 · §5.1
 * phase-1.md §7 G: "The 1:1 invariants hold under attempted violation."
 *
 * The violations are attempted rather than assumed away. A rule that only holds when the
 * application remembers it is not an invariant, and the only way to know the index is
 * doing the work is to write against it.
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
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { linkDocument, linkInvoice } from "../../src/matching/link";

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

async function insertTransaction(occurrenceIndex = 0) {
  const [row] = await h.db
    .insert(canonicalTransactions)
    .values({
      workspaceId,
      bankAccountId,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      direction: "DEBIT",
      currency: "USD",
      description: "ANTHROPIC",
      descriptionNormalized: "anthropic",
      occurrenceIndex,
    })
    .returning();
  return row;
}

async function insertDocument(state: "EXTRACTED" | "UNREADABLE" = "EXTRACTED") {
  const [row] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: "documents/x.pdf",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      source: "MANUAL_UPLOAD",
      state,
    })
    .returning();
  return row;
}

/** An invoice with its primary document, as understand.ts leaves them. */
async function insertInvoice() {
  const document = await insertDocument();
  const [invoice] = await h.db
    .insert(invoices)
    .values({ workspaceId, totalMinor: 2000n, currency: "USD" })
    .returning();
  await h.db
    .insert(invoiceDocuments)
    .values({ workspaceId, invoiceId: invoice.id, documentId: document.id, isPrimary: true });
  return { invoice, document };
}

async function insertRequirement(transactionId: string) {
  const [row] = await h.db
    .insert(invoiceRequirements)
    .values({ workspaceId, canonicalTransactionId: transactionId })
    .returning();
  return row;
}

describe("linking an invoice to its payment", () => {
  it("writes the link and resolves the requirement", async () => {
    const txn = await insertTransaction();
    const { invoice, document } = await insertInvoice();
    await insertRequirement(txn.id);

    const outcome = await linkInvoice(scope, invoice.id, txn.id, "AUTO_MATCHED");

    expect(outcome).toEqual({ linked: true, requirementResolved: true });

    const [linked] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(linked.canonicalTransactionId).toBe(txn.id);

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.state).toBe("RESOLVED");
    expect(requirement.resolutionMethod).toBe("AUTO_MATCHED");
    expect(requirement.resolvedDocumentId).toBe(document.id);
  });

  it("links a payment nothing asked about", async () => {
    // §14: an upload with no requirement to resolve still creates the Invoice and may be
    // linked. Nothing was missing, so nothing is resolved and the report is unchanged.
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();

    const outcome = await linkInvoice(scope, invoice.id, txn.id, "AUTO_MATCHED");

    expect(outcome).toEqual({ linked: true, requirementResolved: false });
  });
});

describe("two things reaching for one payment", () => {
  it("refuses a second invoice on a payment that has one", async () => {
    // Invariant 9, and the index is what enforces it -- not a check this code performs,
    // because between a check and a write the answer can change.
    const txn = await insertTransaction();
    const first = await insertInvoice();
    const second = await insertInvoice();

    await linkInvoice(scope, first.invoice.id, txn.id, "AUTO_MATCHED");
    const outcome = await linkInvoice(scope, second.invoice.id, txn.id, "AUTO_MATCHED");

    expect(outcome.linked).toBe(false);
    expect(outcome.linked === false && outcome.reason).toBe("That payment already has an invoice.");
  });

  it("leaves the first link untouched when it refuses the second", async () => {
    const txn = await insertTransaction();
    const first = await insertInvoice();
    const second = await insertInvoice();

    await linkInvoice(scope, first.invoice.id, txn.id, "AUTO_MATCHED");
    await linkInvoice(scope, second.invoice.id, txn.id, "USER_LINKED");

    const [winner] = await h.db.select().from(invoices).where(eq(invoices.id, first.invoice.id));
    const [loser] = await h.db.select().from(invoices).where(eq(invoices.id, second.invoice.id));

    expect(winner.canonicalTransactionId).toBe(txn.id);
    expect(loser.canonicalTransactionId).toBeNull();
  });

  it("produces exactly one winner when both arrive at once", async () => {
    // A matching run and a user clicking, or two runs. The index settles it; this asserts
    // the loser is told rather than throwing.
    const txn = await insertTransaction();
    const first = await insertInvoice();
    const second = await insertInvoice();

    const outcomes = await Promise.all([
      linkInvoice(scope, first.invoice.id, txn.id, "AUTO_MATCHED"),
      linkInvoice(scope, second.invoice.id, txn.id, "AUTO_MATCHED"),
    ]);

    expect(outcomes.filter((o) => o.linked)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.linked)).toHaveLength(1);
  });

  it("refuses to move an invoice that is linked elsewhere", async () => {
    // Invariant 8. Re-pointing an invoice is not this function's job; the user takes the
    // document off one payment through review, deliberately.
    const first = await insertTransaction(0);
    const other = await insertTransaction(1);
    const { invoice } = await insertInvoice();

    await linkInvoice(scope, invoice.id, first.id, "AUTO_MATCHED");
    const outcome = await linkInvoice(scope, invoice.id, other.id, "USER_LINKED");

    expect(outcome.linked === false && outcome.reason).toBe(
      "That invoice is already linked to another payment.",
    );
  });
});

describe("running it twice", () => {
  it("treats an invoice already on this payment as finished", async () => {
    // A retried background workflow must not collide with itself.
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();
    await insertRequirement(txn.id);

    await linkInvoice(scope, invoice.id, txn.id, "AUTO_MATCHED");
    const again = await linkInvoice(scope, invoice.id, txn.id, "AUTO_MATCHED");

    expect(again.linked).toBe(true);
  });

  it("does not overwrite the method a user chose with one a machine did", async () => {
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();
    await insertRequirement(txn.id);

    await linkInvoice(scope, invoice.id, txn.id, "USER_LINKED");
    await linkInvoice(scope, invoice.id, txn.id, "AUTO_MATCHED");

    const [requirement] = await h.db.select().from(invoiceRequirements);
    expect(requirement.resolutionMethod).toBe("USER_LINKED");
  });

  it("resolves the requirement once, not once per attempt", async () => {
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();
    await insertRequirement(txn.id);

    const first = await linkInvoice(scope, invoice.id, txn.id, "AUTO_MATCHED");
    const second = await linkInvoice(scope, invoice.id, txn.id, "AUTO_MATCHED");

    expect(first.linked && first.requirementResolved).toBe(true);
    expect(second.linked && second.requirementResolved).toBe(false);
    expect(await h.db.select().from(invoiceRequirements)).toHaveLength(1);
  });
});

describe("a document that is not an invoice", () => {
  it("links straight to the payment and resolves the requirement", async () => {
    // §5.1: a payment confirmation too thin to extract is still evidence the business
    // has. It resolves the requirement with no Invoice ever existing.
    const txn = await insertTransaction();
    const document = await insertDocument("UNREADABLE");
    await insertRequirement(txn.id);

    const outcome = await linkDocument(scope, document.id, txn.id, "USER_LINKED");

    expect(outcome).toEqual({ linked: true, requirementResolved: true });

    const [row] = await h.db.select().from(supportingDocuments);
    expect(row.canonicalTransactionId).toBe(txn.id);
    expect(await h.db.select().from(invoices)).toHaveLength(0);
  });

  it("allows several documents on one payment", async () => {
    // Invariant 17: a transaction may hold several supporting documents and at most one
    // invoice. The one-to-one rule constrains invoices, not arbitrary evidence.
    const txn = await insertTransaction();
    const first = await insertDocument("UNREADABLE");
    const second = await insertDocument("UNREADABLE");

    await linkDocument(scope, first.id, txn.id, "USER_LINKED");
    const outcome = await linkDocument(scope, second.id, txn.id, "USER_LINKED");

    expect(outcome.linked).toBe(true);
  });

  it("does not prevent an invoice being linked to the same payment", async () => {
    const txn = await insertTransaction();
    const receipt = await insertDocument("UNREADABLE");
    const { invoice } = await insertInvoice();

    await linkDocument(scope, receipt.id, txn.id, "USER_LINKED");
    const outcome = await linkInvoice(scope, invoice.id, txn.id, "USER_CONFIRMED");

    expect(outcome.linked).toBe(true);
  });
});

describe("reaching for something that is not yours", () => {
  it("cannot tell an attacker the invoice exists", async () => {
    // Identical to "no such invoice", deliberately -- the choice WorkspaceAccessError
    // already made. Distinguishing the two tells an attacker which ids are real.
    const other = await seedWorkspace(h.db, "Attacker Business");
    const attacker = new WorkspaceScope(h.db, other.workspace.id, other.user.id);
    const txn = await insertTransaction();
    const { invoice } = await insertInvoice();

    const outcome = await linkInvoice(attacker, invoice.id, txn.id, "USER_LINKED");

    expect(outcome.linked).toBe(false);
    expect(outcome.linked === false && outcome.reason).toBe("We couldn't find that invoice.");

    const [untouched] = await h.db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(untouched.canonicalTransactionId).toBeNull();
  });
});
