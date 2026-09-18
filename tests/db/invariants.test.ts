/**
 * Domain invariants, as enforced by the database.
 *
 * spec: docs/domain-model.md §10 · docs/architecture.md §2.6
 *
 * These test the constraints in the migration rather than any application code, because
 * that is where the rules are meant to live. A rule that only holds when the application
 * remembers it is not an invariant.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

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
  bankStatements,
  canonicalTransactions,
  clarificationQuestions,
  invoiceRequirements,
  invoices,
  reconciliationRuns,
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

describe("a statement waiting for its account", () => {
  // spec: docs/state-machines.md §1 · upload-statement Step 3a
  //
  // NEEDS_ACCOUNT exists so the workflow can finish while the user is away. The shape it
  // depends on is that the state is reachable with no binding at all — if the column were
  // required, the pause would have to be represented somewhere else.
  it("holds NEEDS_ACCOUNT with no bank account bound", async () => {
    const [statement] = await h.db
      .insert(bankStatements)
      .values({
        workspaceId,
        uploadBatchId: randomUUID(),
        filename: "march.pdf",
        mimeType: "application/pdf",
        storageRef: "workspaces/x/statements/y/march.pdf",
        state: "NEEDS_ACCOUNT" as const,
        identifiedBankName: "HDFC Bank",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
      })
      .returning();

    expect(statement.state).toBe("NEEDS_ACCOUNT");
    expect(statement.bankAccountId).toBeNull();
    // What the document said survives independently of what it was bound to.
    expect(statement.identifiedBankName).toBe("HDFC Bank");
  });

  it("records no period source when it has no period", async () => {
    // `docs/decisions/0008`: the two are null together. A source with no range says nothing,
    // and a range with no source is a range coverage cannot weigh.
    const [statement] = await h.db
      .insert(bankStatements)
      .values({
        workspaceId,
        uploadBatchId: randomUUID(),
        filename: "no-period.pdf",
        mimeType: "application/pdf",
        storageRef: "workspaces/x/statements/y/no-period.pdf",
        state: "PARSING" as const,
        identifiedBankName: "Bank of Ireland",
      })
      .returning();

    expect(statement.periodStart).toBeNull();
    expect(statement.periodSource).toBeNull();
  });
});

describe("an account and the kind of account it is", () => {
  // spec: docs/decisions/0008-statement-period-provenance.md
  it("is a bank account unless something says otherwise", async () => {
    // The seeded account names no kind, the way every row written before this column
    // existed named none. The default is what makes those rows still true.
    const [account] = await h.db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.id, bankAccountId));
    expect(account.accountKind).toBe("BANK_ACCOUNT");
  });

  it("does not let the kind split one account into two", async () => {
    await h.db.insert(bankAccounts).values({
      workspaceId,
      bankName: "ICICI Bank",
      accountIdentifier: "XXXX9012",
      accountKind: "BANK_ACCOUNT" as const,
      currency: "INR",
    });

    /*
     * The same workspace, bank and identifier is the same account, whatever kind it is
     * called. `bank_accounts_identity_idx` deliberately excludes the kind: canonical
     * transactions are keyed on `bankAccountId`, so an account existing twice would put a
     * business's movements in two places and silently defeat the deduplication Step 5a
     * calls the one failure that destroys a real payment.
     */
    await expectUniqueViolation(
      () =>
        h.db.insert(bankAccounts).values({
          workspaceId,
          bankName: "ICICI Bank",
          accountIdentifier: "XXXX9012",
          accountKind: "CREDIT_CARD" as const,
          currency: "INR",
        }),
      "bank_accounts_identity_idx",
    );
  });

  it("does not let the spelling of a bank name split one account into two", async () => {
    await h.db.insert(bankAccounts).values({
      workspaceId,
      bankName: "AXIS BANK",
      accountIdentifier: "921010042890365",
      currency: "INR",
    });

    /*
     * The observed bug. Identification reported "AXIS BANK" for one upload of a statement
     * and "Axis Bank" for the next, and a case-sensitive index made those two accounts for
     * one real account. Case is how a statement is typeset, not which account it is.
     */
    await expectUniqueViolation(
      () =>
        h.db.insert(bankAccounts).values({
          workspaceId,
          bankName: "Axis Bank",
          accountIdentifier: "921010042890365",
          currency: "INR",
        }),
      "bank_accounts_identity_idx",
    );
  });

  it("does not let the case of a masked identifier split one account into two", async () => {
    await h.db.insert(bankAccounts).values({
      workspaceId,
      bankName: "Yes Bank",
      accountIdentifier: "XXXX4321",
      currency: "INR",
    });

    // Banks print a mask both ways, sometimes on different pages of one statement.
    await expectUniqueViolation(
      () =>
        h.db.insert(bankAccounts).values({
          workspaceId,
          bankName: "Yes Bank",
          accountIdentifier: "xxxx4321",
          currency: "INR",
        }),
      "bank_accounts_identity_idx",
    );
  });

  it("still treats genuinely different banks as different accounts", async () => {
    // The normalization folds typesetting, not identity. Deciding that "HDFC Bank" and
    // "HDFC BANK LIMITED" are one institution is entity resolution, and a wrong merge is
    // the expensive direction.
    await h.db.insert(bankAccounts).values({
      workspaceId,
      bankName: "HDFC BANK LIMITED",
      accountIdentifier: "50100158077633",
      currency: "INR",
    });
    const [second] = await h.db
      .insert(bankAccounts)
      .values({
        workspaceId,
        bankName: "HDFC Bank",
        accountIdentifier: "50100158077633",
        currency: "INR",
      })
      .returning();

    expect(second.id).toBeDefined();
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

  // spec: docs/domain-model.md §3.13
  it("outlives the run that identified it", async () => {
    // A run is a record of work performed, not a source of truth about the requirement's
    // state. So the FK is `set null`, and deleting run history must never take the
    // requirements and questions with it -- which `cascade` silently would.
    const txn = await insertTransaction();
    const [run] = await h.db.insert(reconciliationRuns).values({ workspaceId }).returning();

    await h.db
      .insert(invoiceRequirements)
      .values({ workspaceId, canonicalTransactionId: txn.id, reconciliationRunId: run.id });
    await h.db.insert(clarificationQuestions).values({
      workspaceId,
      canonicalTransactionId: txn.id,
      reconciliationRunId: run.id,
      question: "Is XYZ Services a business vendor?",
    });

    await h.db.delete(reconciliationRuns).where(eq(reconciliationRuns.id, run.id));

    const [req] = await h.db.select().from(invoiceRequirements);
    const [question] = await h.db.select().from(clarificationQuestions);

    expect(req).toBeDefined();
    expect(req.reconciliationRunId).toBeNull();
    expect(question).toBeDefined();
    expect(question.reconciliationRunId).toBeNull();
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
