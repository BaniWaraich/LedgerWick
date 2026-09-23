/**
 * Noticing an invoice the business already has.
 *
 * spec: docs/workflows/manual-invoice-upload.md §13 · docs/domain-model.md Rule 11
 *
 * The model is a stub that throws unless a test expects it to be called. That is how the
 * tier-1 tests prove the deterministic path is deterministic: if the model were consulted,
 * the test would fail rather than quietly pass for the wrong reason.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { invoices, vendors } from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import type { JudgeSameInvoice } from "../../src/matching/contracts";
import { findDuplicate, flagDuplicate } from "../../src/matching/duplicates";

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

/** A model that must not be reached. */
const neverAsked: JudgeSameInvoice = async () => {
  throw new Error("the model was consulted when the fields already settled it");
};

const says =
  (same: "YES" | "UNSURE" | "NO"): JudgeSameInvoice =>
  async () => ({
    ok: true,
    value: { same, reason: `model said ${same}` },
  });

/** The model could not answer — a schema failure, not a crash. */
const cannotAnswer: JudgeSameInvoice = async () => ({ ok: false, reason: "schema rejected" });

async function insertInvoice(overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
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
  return row;
}

const deps = (judge: JudgeSameInvoice) => ({ judge, vendorName: "Anthropic" });

describe("when the fields settle it", () => {
  it("flags the same invoice arriving twice without asking a model", async () => {
    // §13's case: retrieved from Gmail, then uploaded by hand.
    const original = await insertInvoice();
    const copy = await insertInvoice();

    const found = await findDuplicate(scope, copy, deps(neverAsked));

    expect(found?.ofInvoiceId).toBe(original.id);
    expect(found?.reason).toBe("Same vendor, amount, date and invoice number");
  });

  it("tolerates a date a day or two out", async () => {
    // A re-sent invoice, or a scan read slightly wrong. Still one charge.
    const original = await insertInvoice();
    const copy = await insertInvoice({ invoiceDate: "2026-04-15" });

    expect((await findDuplicate(scope, copy, deps(neverAsked)))?.ofInvoiceId).toBe(original.id);
  });

  it("matches an invoice number written with different punctuation", async () => {
    const original = await insertInvoice({ invoiceNumber: "INV-92831" });
    const copy = await insertInvoice({ invoiceNumber: "inv 92831" });

    expect((await findDuplicate(scope, copy, deps(neverAsked)))?.ofInvoiceId).toBe(original.id);
  });
});

describe("when the fields are inconclusive", () => {
  it("asks, and flags when the model says these are one invoice", async () => {
    const original = await insertInvoice();
    const copy = await insertInvoice({ invoiceNumber: "ANT-92831-R" });

    const found = await findDuplicate(scope, copy, deps(says("YES")));

    expect(found?.ofInvoiceId).toBe(original.id);
    expect(found?.reason).toBe("model said YES");
  });

  it("flags on uncertainty rather than passing", async () => {
    // §13: the system must not silently create a second invoice. One unnecessary
    // comparison costs the owner a moment; a charge recorded twice costs more.
    const original = await insertInvoice();
    const copy = await insertInvoice({ invoiceNumber: "ANT-92831-R" });

    expect((await findDuplicate(scope, copy, deps(says("UNSURE"))))?.ofInvoiceId).toBe(original.id);
  });

  it("flags when the model could not answer at all", async () => {
    // A schema failure is not a verdict of NO. Silence reads the same way as uncertainty.
    const original = await insertInvoice();
    const copy = await insertInvoice({ invoiceNumber: "ANT-92831-R" });

    const found = await findDuplicate(scope, copy, deps(cannotAnswer));

    expect(found?.ofInvoiceId).toBe(original.id);
    expect(found?.reason).toContain("could not check");
  });

  it("lets two genuinely different invoices through", async () => {
    await insertInvoice();
    const other = await insertInvoice({ invoiceNumber: "ANT-99999" });

    expect(await findDuplicate(scope, other, deps(says("NO")))).toBeNull();
  });
});

describe("what is never even asked about", () => {
  it("does not question a monthly subscription", async () => {
    // Same vendor, same amount, a month apart, different numbers. A business on a monthly
    // plan gets one of these every month and they are different charges. Asking about
    // each would make the feature a nuisance.
    await insertInvoice({ invoiceDate: "2026-03-14", invoiceNumber: "INV-1" });
    const april = await insertInvoice({ invoiceDate: "2026-04-14", invoiceNumber: "INV-2" });

    // Two fields agree (vendor, amount), so it reaches the model -- and the model is what
    // separates a monthly charge from a re-sent invoice.
    expect(await findDuplicate(scope, april, deps(says("NO")))).toBeNull();
  });

  it("does not compare across vendors", async () => {
    const [other] = await h.db
      .insert(vendors)
      .values({ workspaceId, name: "Someone Else" })
      .returning();
    await insertInvoice();
    const unrelated = await insertInvoice({ vendorId: other.id });

    expect(await findDuplicate(scope, unrelated, deps(neverAsked))).toBeNull();
  });

  it("does not compare an invoice whose vendor was never resolved", async () => {
    // Without a vendor there is no cheap way to narrow the comparison, and the fields
    // left would flag every invoice of the same round amount.
    await insertInvoice();
    const orphan = await insertInvoice({ vendorId: null });

    expect(await findDuplicate(scope, orphan, deps(neverAsked))).toBeNull();
  });

  it("points at the original rather than at another copy", async () => {
    // A third copy forming a chain is a record nobody can read.
    const original = await insertInvoice();
    const second = await insertInvoice();
    await flagDuplicate(scope, second.id, { ofInvoiceId: original.id, reason: "Same everything" });

    const third = await insertInvoice();

    expect((await findDuplicate(scope, third, deps(neverAsked)))?.ofInvoiceId).toBe(original.id);
  });

  it("never reaches another workspace's invoices", async () => {
    const other = await seedWorkspace(h.db, "Someone Else");
    const [theirVendor] = await h.db
      .insert(vendors)
      .values({ workspaceId: other.workspace.id, name: "Anthropic" })
      .returning();
    await h.db.insert(invoices).values({
      workspaceId: other.workspace.id,
      vendorId: theirVendor.id,
      invoiceNumber: "INV-92831",
      invoiceDate: "2026-04-14",
      totalMinor: 2000n,
      currency: "USD",
    });

    const mine = await insertInvoice();

    expect(await findDuplicate(scope, mine, deps(neverAsked))).toBeNull();
  });
});

describe("recording the suspicion", () => {
  it("writes the pointer and the reason, and links nothing", async () => {
    const original = await insertInvoice();
    const copy = await insertInvoice();

    await flagDuplicate(scope, copy.id, {
      ofInvoiceId: original.id,
      reason: "Same vendor, amount, date and invoice number",
    });

    const [flagged] = await h.db.select().from(invoices).where(eq(invoices.id, copy.id));
    expect(flagged.suspectedDuplicateOfInvoiceId).toBe(original.id);
    expect(flagged.duplicateReason).toBe("Same vendor, amount, date and invoice number");
    // Nothing is deleted and nothing is merged. §8 puts that decision with the user.
    expect(await h.db.select().from(invoices)).toHaveLength(2);
  });
});
