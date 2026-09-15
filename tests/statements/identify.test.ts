/**
 * Identifying a statement and binding it to an account.
 *
 * spec: docs/workflows/upload-statement.md Step 3, Step 3a · docs/state-machines.md §1
 *
 * The model is a parameter here, so these are tests of the decision, not of a provider.
 * What each branch has to get right is which persisted state the user is left in — that
 * state is the whole output of this step, and the next feature reads nothing else.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { FakeDocumentStore } from "../storage/fake-document-store";
import { bankAccounts, bankStatements } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import type { Identification } from "../../src/ai/prompts/identify-statement.v1";
import { identifyStatement, type IdentifyDocument } from "../../src/statements/identify";
import { intakeBatch } from "../../src/statements/intake";

let h: TestDb;
let scope: WorkspaceScope;

beforeAll(async () => {
  h = await createTestDb();
  const alice = await seedWorkspace(h.db, "Alice Traders");
  scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
});

afterAll(async () => {
  await h.close();
});

/** A complete, well-identified HDFC statement. Overridden per branch. */
function identification(overrides: Partial<Identification> = {}): Identification {
  return {
    isBankStatement: true,
    bankName: "HDFC Bank",
    accountIdentifier: "XXXX1234",
    accountType: "Current",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    ...overrides,
  };
}

function modelReturning(value: Identification): IdentifyDocument {
  return async () => ({ ok: true, value });
}

const modelThatFails: IdentifyDocument = async () => ({ ok: false, reason: "provider timeout" });

/** An uploaded, stored statement awaiting identification. */
async function uploaded(store: FakeDocumentStore): Promise<string> {
  const { results } = await intakeBatch(
    scope,
    store,
    [new File(["Date,Amount\n"], "march.csv", { type: "text/csv" })],
    async () => {},
  );
  return results[0].statementId!;
}

async function stateOf(statementId: string) {
  const [row] = await scope.select(bankStatements, eq(bankStatements.id, statementId));
  return row;
}

describe("a statement that names its account", () => {
  it("creates the account, binds it, and moves to PARSING", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), id);

    const row = await stateOf(id);
    expect(row.state).toBe("PARSING");
    expect(row.periodStart).toBe("2026-03-01");
    expect(row.periodEnd).toBe("2026-03-31");
    expect(row.bankAccountId).not.toBeNull();

    const [account] = await scope.select(bankAccounts, eq(bankAccounts.id, row.bankAccountId!));
    expect(account.bankName).toBe("HDFC Bank");
    expect(account.accountIdentifier).toBe("XXXX1234");
    expect(account.currency).toBe("INR");
  });

  it("reuses the account a previous statement created", async () => {
    const store = new FakeDocumentStore();
    const first = await uploaded(store);
    const second = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), first);
    await identifyStatement(scope, store, modelReturning(identification()), second);

    // Step 3a: the same identifier in the same workspace is the same account, not a
    // second one — coverage and canonical dedup in feature D depend on this holding.
    expect((await stateOf(second)).bankAccountId).toBe((await stateOf(first)).bankAccountId);
  });

  it("keeps what the document said alongside the binding", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), id);

    const row = await stateOf(id);
    expect(row.identifiedBankName).toBe("HDFC Bank");
    expect(row.identifiedAccountIdentifier).toBe("XXXX1234");
    expect(row.identifiedAccountType).toBe("Current");
  });
});

describe("a statement that does not name its account", () => {
  it("waits for the user rather than guessing", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);
    const accountsBefore = (await scope.select(bankAccounts)).length;

    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ accountIdentifier: null })),
      id,
    );

    const row = await stateOf(id);
    // Step 3a: "A statement is never bound to an account by inference alone when the
    // identifier is absent."
    expect(row.state).toBe("NEEDS_ACCOUNT");
    expect(row.bankAccountId).toBeNull();
    // The period is still known, and what the document did say is shown to the user.
    expect(row.periodStart).toBe("2026-03-01");
    expect(row.identifiedBankName).toBe("HDFC Bank");
    // Nothing was created on the strength of a bank name alone.
    expect(await scope.select(bankAccounts)).toHaveLength(accountsBefore);
  });
});

describe("a statement we cannot use", () => {
  it("fails when the document is not a bank statement", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ isBankStatement: false })),
      id,
    );

    const row = await stateOf(id);
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toMatch(/doesn't look like a bank statement/);
  });

  it("fails when the period cannot be determined", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ periodStart: null, periodEnd: null })),
      id,
    );

    const row = await stateOf(id);
    // Step 3 is explicit that this fails rather than being silently accepted: without a
    // period there is no coverage, and a reconciliation run cannot say what it examined.
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toMatch(/dates this statement covers/);
    expect(row.bankAccountId).toBeNull();
  });

  it("fails when the model cannot answer", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelThatFails, id);

    const row = await stateOf(id);
    // A failed inference is an outcome recorded as state, not an exception that takes the
    // workflow down (definition of done, "When it touches an LLM").
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toMatch(/couldn't read this statement/);
  });
});

describe("running identification again", () => {
  it("changes nothing once the statement has moved on", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    await identifyStatement(scope, store, modelReturning(identification()), id);
    const afterFirst = await stateOf(id);

    // A replayed event, or a retry after the step already committed. A second account, or
    // a rebinding, would be the damage.
    await identifyStatement(
      scope,
      store,
      modelReturning(identification({ accountIdentifier: "XXXX9999" })),
      id,
    );

    const afterSecond = await stateOf(id);
    expect(afterSecond.state).toBe("PARSING");
    expect(afterSecond.bankAccountId).toBe(afterFirst.bankAccountId);
    expect(
      await scope.select(bankAccounts, eq(bankAccounts.accountIdentifier, "XXXX9999")),
    ).toHaveLength(0);
  });

  it("does nothing for a statement belonging to another workspace", async () => {
    const store = new FakeDocumentStore();
    const id = await uploaded(store);

    const bob = await seedWorkspace(h.db, "Bob Industries");
    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);

    // The shape of a tampered event: Bob's scope, Alice's statement id.
    await identifyStatement(bobScope, store, modelReturning(identification()), id);

    expect((await stateOf(id)).state).toBe("UPLOADING");
    expect(await bobScope.select(bankAccounts)).toHaveLength(0);
  });
});
