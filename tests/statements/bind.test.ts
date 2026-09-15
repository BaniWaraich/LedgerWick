/**
 * The user choosing the account a statement covers.
 *
 * spec: docs/workflows/upload-statement.md Step 3a · docs/state-machines.md §1
 *
 * This is the half of Step 3a that runs with a person present, so the value under attack
 * is the account id arriving from a form — the definition of done requires that no
 * workspace identifier from a client is trusted without a check.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { FakeDocumentStore } from "../storage/fake-document-store";
import { bankAccounts, bankStatements } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import type { Identification } from "../../src/ai/prompts/identify-statement.v1";
import {
  bindStatementToAccount,
  StatementNotWaitingError,
  UnknownBankAccountError,
} from "../../src/statements/bind";
import { identifyStatement } from "../../src/statements/identify";
import { intakeBatch } from "../../src/statements/intake";

let h: TestDb;
let alice: Awaited<ReturnType<typeof seedWorkspace>>;
let scope: WorkspaceScope;

beforeAll(async () => {
  h = await createTestDb();
  alice = await seedWorkspace(h.db, "Alice Traders");
  scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
});

afterAll(async () => {
  await h.close();
});

const unidentifiedAccount: Identification = {
  isBankStatement: true,
  bankName: "HDFC Bank",
  accountIdentifier: null,
  accountType: "Current",
  periodStart: "2026-03-01",
  periodEnd: "2026-03-31",
};

/** A statement that reached NEEDS_ACCOUNT the way a real one does. */
async function waitingStatement(target: WorkspaceScope = scope): Promise<string> {
  const store = new FakeDocumentStore();
  const { results } = await intakeBatch(
    target,
    store,
    [new File(["Date,Amount\n"], "march.csv", { type: "text/csv" })],
    async () => {},
  );
  const id = results[0].statementId!;
  await identifyStatement(
    target,
    store,
    async () => ({ ok: true, value: unidentifiedAccount }),
    id,
  );
  return id;
}

async function stateOf(target: WorkspaceScope, statementId: string) {
  const [row] = await target.select(bankStatements, eq(bankStatements.id, statementId));
  return row;
}

describe("choosing an existing account", () => {
  it("binds it and lets parsing proceed", async () => {
    const id = await waitingStatement();
    const [account] = await scope.insert(bankAccounts, {
      bankName: "HDFC Bank",
      accountIdentifier: "XXXX1111",
      currency: "INR",
    });

    await bindStatementToAccount(scope, id, { bankAccountId: account.id });

    const row = await stateOf(scope, id);
    expect(row.state).toBe("PARSING");
    expect(row.bankAccountId).toBe(account.id);
  });

  it("refuses an account from another workspace", async () => {
    const id = await waitingStatement();

    const bob = await seedWorkspace(h.db, "Bob Industries");
    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);
    const [bobAccount] = await bobScope.insert(bankAccounts, {
      bankName: "ICICI Bank",
      accountIdentifier: "XXXX2222",
      currency: "INR",
    });

    // A real account id, posted into Alice's form. Step 3a: an account in another
    // workspace is not a match and must not be reachable in any form.
    await expect(
      bindStatementToAccount(scope, id, { bankAccountId: bobAccount.id }),
    ).rejects.toBeInstanceOf(UnknownBankAccountError);

    expect((await stateOf(scope, id)).state).toBe("NEEDS_ACCOUNT");
  });
});

describe("creating an account", () => {
  it("creates it in this workspace and binds it", async () => {
    const id = await waitingStatement();

    await bindStatementToAccount(scope, id, {
      bankName: "Axis Bank",
      accountIdentifier: "XXXX3333",
    });

    const row = await stateOf(scope, id);
    expect(row.state).toBe("PARSING");

    const [account] = await scope.select(bankAccounts, eq(bankAccounts.id, row.bankAccountId!));
    expect(account.workspaceId).toBe(alice.workspace.id);
    // The account type the document did state is carried onto the account the user makes.
    expect(account.accountType).toBe("Current");
  });
});

describe("a statement that is not waiting", () => {
  it("refuses a second binding", async () => {
    const id = await waitingStatement();
    await bindStatementToAccount(scope, id, {
      bankName: "Yes Bank",
      accountIdentifier: "XXXX4444",
    });
    const bound = await stateOf(scope, id);

    // A stale form or a back button. Rebinding a statement that has moved on would
    // silently reattach a business's transactions to a different account.
    await expect(
      bindStatementToAccount(scope, id, {
        bankName: "Yes Bank",
        accountIdentifier: "XXXX5555",
      }),
    ).rejects.toBeInstanceOf(StatementNotWaitingError);

    expect((await stateOf(scope, id)).bankAccountId).toBe(bound.bankAccountId);
  });

  it("refuses a statement belonging to another workspace", async () => {
    const id = await waitingStatement();

    const carol = await seedWorkspace(h.db, "Carol Consulting");
    const carolScope = await openWorkspace(h.db, carol.user.id, carol.workspace.id);

    await expect(
      carolScope.selectOne(bankStatements, eq(bankStatements.id, id)),
    ).resolves.toBeNull();
    await expect(
      bindStatementToAccount(carolScope, id, {
        bankName: "HDFC Bank",
        accountIdentifier: "XXXX6666",
      }),
    ).rejects.toBeInstanceOf(StatementNotWaitingError);

    expect((await stateOf(scope, id)).state).toBe("NEEDS_ACCOUNT");
  });
});
