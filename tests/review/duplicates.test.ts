/**
 * Deciding whether two documents are the same invoice.
 *
 * spec: docs/workflows/invoice-match-review.md §8 · docs/domain-model.md Rule 11
 *
 * The load-bearing test is "keeps both files" — §8's "nothing is deleted" is a promise
 * about files, and it is the one a merge could most easily break.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  canonicalTransactions,
  invoiceDocuments,
  invoices,
  supportingDocuments,
  vendors,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { compareInvoices, keepBoth, keepOne } from "../../src/review/duplicates";

let h: TestDb;
let scope: WorkspaceScope;
let workspaceId: string;
let vendorId: string;

beforeEach(async () => {
  h = await createTestDb();
  const { workspace, user } = await seedWorkspace(h.db);
  workspaceId = workspace.id;
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

async function insertInvoice(filename: string, overrides: Record<string, unknown> = {}) {
  const [document] = await h.db
    .insert(supportingDocuments)
    .values({
      workspaceId,
      storageRef: `documents/${filename}`,
      filename,
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

/** The original, and a copy flagged against it. */
async function aSuspectedDuplicate() {
  const original = await insertInvoice("from-gmail.pdf");
  const copy = await insertInvoice("uploaded-by-hand.pdf", {
    suspectedDuplicateOfInvoiceId: original.invoice.id,
    duplicateReason: "Same vendor, amount, date and invoice number",
  });
  return { original, copy };
}

describe("showing the two side by side", () => {
  const anthropic = {
    vendorName: "Anthropic",
    invoiceNumber: "INV-92831",
    invoiceDate: "2026-04-14",
    amount: "USD 2000",
  };

  it("marks the fields that agree", () => {
    const fields = compareInvoices(anthropic, anthropic);

    expect(fields.every((field) => field.agrees)).toBe(true);
    expect(fields.map((field) => field.field)).toEqual([
      "Vendor",
      "Invoice number",
      "Date",
      "Amount",
    ]);
  });

  it("sees through punctuation, as everything else here does", () => {
    const fields = compareInvoices(anthropic, { ...anthropic, invoiceNumber: "inv 92831" });

    expect(fields.find((field) => field.field === "Invoice number")?.agrees).toBe(true);
  });

  it("marks the fields that disagree", () => {
    const fields = compareInvoices(anthropic, { ...anthropic, amount: "USD 9900" });

    expect(fields.find((field) => field.field === "Amount")?.agrees).toBe(false);
  });

  it("calls a missing field neither agreement nor disagreement", () => {
    // §6 says an invoice number is not universally mandatory. Absent on one side is not
    // evidence that they differ.
    const fields = compareInvoices(anthropic, { ...anthropic, invoiceNumber: null });

    expect(fields.find((field) => field.field === "Invoice number")?.agrees).toBeNull();
  });

  it("shows both values whatever they say", () => {
    // §8 puts them in two columns so the user can read rather than be argued at.
    const fields = compareInvoices(anthropic, { ...anthropic, amount: "USD 9900" });
    const amount = fields.find((field) => field.field === "Amount");

    expect(amount?.existing).toBe("USD 2000");
    expect(amount?.incoming).toBe("USD 9900");
  });
});

describe("they are the same invoice", () => {
  it("keeps both files", async () => {
    // §8: "Nothing is deleted — the user asked to deduplicate a record, not to destroy a
    // file." This asserts on the documents, because that is what the promise is about.
    const { original, copy } = await aSuspectedDuplicate();

    await keepOne(scope, copy.invoice.id, original.document.id);

    const documents = await h.db.select().from(supportingDocuments);
    expect(documents).toHaveLength(2);
    expect(documents.map((document) => document.storageRef).sort()).toEqual([
      "documents/from-gmail.pdf",
      "documents/uploaded-by-hand.pdf",
    ]);
  });

  it("makes them both documents of one invoice", async () => {
    const { original, copy } = await aSuspectedDuplicate();

    expect(await keepOne(scope, copy.invoice.id, original.document.id)).toEqual({ merged: true });

    const joins = await h.db.select().from(invoiceDocuments);
    expect(joins).toHaveLength(2);
    expect(new Set(joins.map((join) => join.invoiceId))).toEqual(new Set([original.invoice.id]));
  });

  it("removes the redundant record", async () => {
    const { original, copy } = await aSuspectedDuplicate();

    await keepOne(scope, copy.invoice.id, original.document.id);

    const remaining = await h.db.select().from(invoices);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(original.invoice.id);
  });

  it("honours which copy the user wants as the main one", async () => {
    const { original, copy } = await aSuspectedDuplicate();

    await keepOne(scope, copy.invoice.id, copy.document.id);

    const joins = await h.db.select().from(invoiceDocuments);
    const primary = joins.filter((join) => join.isPrimary);

    expect(primary).toHaveLength(1);
    expect(primary[0].documentId).toBe(copy.document.id);
    // And the one that was primary before is demoted rather than left alongside it.
    expect(joins.find((join) => join.documentId === original.document.id)?.isPrimary).toBe(false);
  });

  it("refuses when the duplicate is already linked to a payment", async () => {
    // decide.ts never auto-links a flagged invoice, so reaching this needs a user acting
    // in another tab. Merging then would move documents off an invoice that is settled on
    // a payment, and the surviving record would lose the link.
    const { original, copy } = await aSuspectedDuplicate();
    const account = await seedBankAccount(h.db, workspaceId);
    const [txn] = await h.db
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
    await h.db
      .update(invoices)
      .set({ canonicalTransactionId: txn.id })
      .where(eq(invoices.id, copy.invoice.id));

    expect(await keepOne(scope, copy.invoice.id, original.document.id)).toEqual({
      merged: false,
      reason: "That invoice is already linked to a payment.",
    });

    // Untouched: both invoices, both joins where they were.
    expect(await h.db.select().from(invoices)).toHaveLength(2);
    const joins = await h.db.select().from(invoiceDocuments);
    expect(new Set(joins.map((join) => join.invoiceId)).size).toBe(2);
  });

  it("refuses an invoice nobody flagged", async () => {
    const original = await insertInvoice("from-gmail.pdf");

    expect(await keepOne(scope, original.invoice.id, original.document.id)).toEqual({
      merged: false,
      reason: "That is not marked as a duplicate.",
    });
  });

  it("is harmless the second time", async () => {
    const { original, copy } = await aSuspectedDuplicate();

    await keepOne(scope, copy.invoice.id, original.document.id);
    const again = await keepOne(scope, copy.invoice.id, original.document.id);

    expect(again.merged).toBe(false);
    expect(await h.db.select().from(invoices)).toHaveLength(1);
  });
});

describe("they are different invoices", () => {
  it("clears the flag so matching can act on it", async () => {
    // §8: "a separate Invoice is created and matched independently." decide.ts suppressed
    // the automatic link on the flag alone, so clearing it is what makes that possible.
    const { copy } = await aSuspectedDuplicate();

    expect(await keepBoth(scope, copy.invoice.id)).toEqual({ merged: true });

    const [row] = await h.db.select().from(invoices).where(eq(invoices.id, copy.invoice.id));
    expect(row.suspectedDuplicateOfInvoiceId).toBeNull();
    expect(row.duplicateReason).toBeNull();
  });

  it("keeps both invoices", async () => {
    const { copy } = await aSuspectedDuplicate();

    await keepBoth(scope, copy.invoice.id);

    expect(await h.db.select().from(invoices)).toHaveLength(2);
    expect(await h.db.select().from(supportingDocuments)).toHaveLength(2);
  });

  it("is harmless the second time", async () => {
    const { copy } = await aSuspectedDuplicate();

    await keepBoth(scope, copy.invoice.id);

    expect(await keepBoth(scope, copy.invoice.id)).toEqual({
      merged: false,
      reason: "That is not marked as a duplicate.",
    });
  });
});

describe("another workspace's duplicate", () => {
  it("cannot be merged", async () => {
    const other = await seedWorkspace(h.db, "Attacker Business");
    const attacker = new WorkspaceScope(h.db, other.workspace.id, other.user.id);
    const { original, copy } = await aSuspectedDuplicate();

    expect(await keepOne(attacker, copy.invoice.id, original.document.id)).toEqual({
      merged: false,
      reason: "That invoice is no longer here.",
    });

    expect(await h.db.select().from(invoices)).toHaveLength(2);
    expect(await h.db.select().from(invoiceDocuments)).toHaveLength(2);
  });

  it("cannot be separated", async () => {
    const other = await seedWorkspace(h.db, "Attacker Business");
    const attacker = new WorkspaceScope(h.db, other.workspace.id, other.user.id);
    const { copy } = await aSuspectedDuplicate();

    expect((await keepBoth(attacker, copy.invoice.id)).merged).toBe(false);

    const [row] = await h.db.select().from(invoices).where(eq(invoices.id, copy.invoice.id));
    expect(row.suspectedDuplicateOfInvoiceId).not.toBeNull();
  });
});
