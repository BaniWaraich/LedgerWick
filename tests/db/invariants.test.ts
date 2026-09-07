/**
 * Domain invariants, as enforced by the database.
 *
 * spec: docs/domain-model.md §10 · docs/architecture.md §2.6
 *
 * These test the constraints in the migration rather than any application code, because
 * that is where the rules are meant to live. A rule that only holds when the application
 * remembers it is not an invariant.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createTestDb,
  expectUniqueViolation,
  seedBankAccount,
  seedWorkspace,
  type TestDb,
} from "../helpers/db";
import {
  bankAccounts,
  canonicalTransactions,
  invoiceRequirements,
  invoices,
} from "../../src/db/schema";

let h: TestDb;
let workspaceId: string;
let bankAccountId: string;

beforeEach(async () => {
  h = await createTestDb();
  const { workspace } = await seedWorkspace(h.db);
  workspaceId = workspace.id;
  bankAccountId = (await seedBankAccount(h.db, workspaceId)).id;
});

afterEach(async () => {
  await h.close();
});

/** A canonical transaction, with the identity fields overridable per test. */
async function insertTransaction(overrides: Record<string, unknown> = {}) {
  const [row] = await h.db
    .insert(canonicalTransactions)
    .values({
      workspaceId,
      bankAccountId,
      valueDate: "2026-05-05",
      amountMinor: 485000n,
      direction: "DEBIT" as const,
      currency: "INR",
      description: "ANTHROPIC CLAUDE SUBSCRIPTION",
      descriptionNormalized: "anthropic claude subscription",
      occurrenceIndex: 0,
      ...overrides,
    })
    .returning();
  return row;
}

describe("canonical transaction identity", () => {
  // spec: upload-statement Step 5a
  it("rejects the same movement seen twice in overlapping statements", async () => {
    await insertTransaction();
    await expectUniqueViolation(() => insertTransaction(), "canonical_transactions_identity_idx");
  });

  it("allows two genuinely identical payments on the same day", async () => {
    await insertTransaction({ occurrenceIndex: 0 });
    const second = await insertTransaction({ occurrenceIndex: 1 });

    // A business really can pay the same vendor the same amount twice in a day. The
    // occurrence index is what keeps that from being mistaken for a duplicate.
    expect(second.occurrenceIndex).toBe(1);
  });

  it("separates transactions that differ only by direction", async () => {
    await insertTransaction({ direction: "DEBIT" });
    const credit = await insertTransaction({ direction: "CREDIT" });

    // A ₹4,850 refund is not the ₹4,850 payment it reverses.
    expect(credit.direction).toBe("CREDIT");
  });

  it("treats a bank reference as identity on its own", async () => {
    await insertTransaction({ externalReference: "UTR123456" });

    // Different date, amount and description — the same underlying payment per the bank.
    await expectUniqueViolation(
      () =>
        insertTransaction({
          externalReference: "UTR123456",
          valueDate: "2026-05-07",
          amountMinor: 999n,
          descriptionNormalized: "different text entirely",
        }),
      "canonical_transactions_reference_idx",
    );
  });

  it("does not collide transactions that have no bank reference", async () => {
    // A partial index: many NULL references must not be treated as equal.
    await insertTransaction({ externalReference: null, occurrenceIndex: 0 });
    const second = await insertTransaction({ externalReference: null, occurrenceIndex: 1 });

    expect(second.id).toBeDefined();
  });

  it("does not collide across bank accounts", async () => {
    const [other] = await h.db
      .insert(bankAccounts)
      .values({
        workspaceId,
        bankName: "SBI",
        accountIdentifier: "XXXX9999",
        currency: "INR",
      })
      .returning();

    await insertTransaction();
    const onOtherAccount = await insertTransaction({ bankAccountId: other.id });

    expect(onOtherAccount.bankAccountId).toBe(other.id);
  });
});

describe("invoice to transaction is one to one", () => {
  // spec: docs/domain-model.md invariants 8 and 9
  it("refuses a second invoice on the same transaction", async () => {
    const txn = await insertTransaction();

    await h.db.insert(invoices).values({ workspaceId, canonicalTransactionId: txn.id });

    await expectUniqueViolation(
      () => h.db.insert(invoices).values({ workspaceId, canonicalTransactionId: txn.id }),
      "invoices_transaction_idx",
    );
  });

  it("allows many unlinked invoices", async () => {
    // The index is partial. Without that, the second unlinked invoice would collide on
    // NULL and manual uploads awaiting a match would be impossible.
    await h.db.insert(invoices).values({ workspaceId, invoiceNumber: "INV-1" });
    await h.db.insert(invoices).values({ workspaceId, invoiceNumber: "INV-2" });

    const rows = await h.db.select().from(invoices);
    expect(rows).toHaveLength(2);
  });
});

describe("invoice requirements", () => {
  // spec: docs/domain-model.md invariant 16
  it("allows at most one per transaction", async () => {
    const txn = await insertTransaction();

    await h.db.insert(invoiceRequirements).values({ workspaceId, canonicalTransactionId: txn.id });

    await expectUniqueViolation(
      () =>
        h.db.insert(invoiceRequirements).values({ workspaceId, canonicalTransactionId: txn.id }),
      "invoice_requirements_transaction_idx",
    );
  });

  it("starts in IDENTIFIED", async () => {
    const txn = await insertTransaction();
    const [req] = await h.db
      .insert(invoiceRequirements)
      .values({ workspaceId, canonicalTransactionId: txn.id })
      .returning();

    expect(req.state).toBe("IDENTIFIED");
  });
});

describe("money", () => {
  it("survives amounts that a float would round", async () => {
    // Stored as integer minor units precisely so this is exact. 0.1 + 0.2 arithmetic in
    // a bookkeeping product is how numbers quietly stop adding up.
    const txn = await insertTransaction({ amountMinor: 9007199254740993n });
    const [read] = await h.db.select().from(canonicalTransactions);

    expect(read.amountMinor).toBe(txn.amountMinor);
    expect(read.amountMinor).toBe(9007199254740993n);
  });
});
