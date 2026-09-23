/**
 * Workspace isolation.
 *
 * spec: docs/domain-model.md Rule 1, invariant 2 · docs/architecture.md §19
 *
 * Isolation is enforced in application code rather than by row-level security, so these
 * tests are the only thing standing behind it. They are written as attacks: each one tries
 * to reach another workspace's data and asserts that it cannot.
 *
 * docs/definition-of-done.md requires a test in this file for every workspace-scoped
 * feature.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName } from "drizzle-orm";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import {
  bankAccounts,
  bankStatements,
  canonicalTransactions,
  invoiceMatchCandidates,
  invoices,
  vendors,
  workspaces,
} from "../../src/db/schema";
import { intakeBatch } from "../../src/statements/intake";
import { FakeDocumentStore } from "../storage/fake-document-store";
import { WorkspaceAccessError, listWorkspaces, openWorkspace } from "../../src/db/workspace-scope";

let h: TestDb;

// Two businesses owned by two different people, plus a second workspace owned by the
// first person — the case where a single user has more than one business.
let alice: Awaited<ReturnType<typeof seedWorkspace>>;
let bob: Awaited<ReturnType<typeof seedWorkspace>>;
let aliceSecond: Awaited<ReturnType<typeof seedWorkspace>>;

beforeAll(async () => {
  h = await createTestDb();

  alice = await seedWorkspace(h.db, "Alice Traders");
  bob = await seedWorkspace(h.db, "Bob Industries");

  // Alice's second business — same user, different workspace. The case that catches
  // isolation written as "is this the user's data" rather than "is this the workspace's".
  const [secondWorkspace] = await h.db
    .insert(workspaces)
    .values({ ownerId: alice.user.id, name: "Alice Consulting" })
    .returning();
  aliceSecond = { user: alice.user, workspace: secondWorkspace };

  await seedBankAccount(h.db, alice.workspace.id);
  await seedBankAccount(h.db, bob.workspace.id);
});

afterAll(async () => {
  await h.close();
});

describe("opening a workspace", () => {
  it("gives the owner a scope", async () => {
    const scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    expect(scope.workspaceId).toBe(alice.workspace.id);
  });

  it("refuses a workspace belonging to someone else", async () => {
    await expect(openWorkspace(h.db, alice.user.id, bob.workspace.id)).rejects.toThrow(
      WorkspaceAccessError,
    );
  });

  it("refuses a workspace that does not exist", async () => {
    await expect(openWorkspace(h.db, alice.user.id, crypto.randomUUID())).rejects.toThrow(
      WorkspaceAccessError,
    );
  });

  it("does not reveal whether the workspace exists", async () => {
    // A different message for "someone else's" vs "does not exist" would let a caller
    // enumerate which workspace ids are real.
    const message = async (workspaceId: string) => {
      try {
        await openWorkspace(h.db, alice.user.id, workspaceId);
        throw new Error("expected openWorkspace to reject");
      } catch (e) {
        return (e as Error).message.replace(workspaceId, "<id>");
      }
    };

    expect(await message(bob.workspace.id)).toBe(await message(crypto.randomUUID()));
  });
});

describe("reading through a scope", () => {
  it("returns only this workspace's rows", async () => {
    const scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    const rows = await scope.select(bankAccounts);

    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(alice.workspace.id);
  });

  it("cannot reach another workspace's row even when its id is known", async () => {
    const [bobAccount] = await h.db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.workspaceId, bob.workspace.id));

    const scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    const found = await scope.selectOne(bankAccounts, eq(bankAccounts.id, bobAccount.id));

    // The row exists; it is simply not reachable from this scope.
    expect(found).toBeNull();
  });

  it("separates two workspaces owned by the same user", async () => {
    const first = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    const second = await openWorkspace(h.db, alice.user.id, aliceSecond.workspace.id);

    await second.insert(vendors, { name: "Consulting-only vendor" });

    expect(await first.select(vendors)).toHaveLength(0);
    expect(await second.select(vendors)).toHaveLength(1);
  });
});

describe("writing through a scope", () => {
  it("stamps the scope's workspace onto inserted rows", async () => {
    const scope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);
    const [vendor] = await scope.insert(vendors, { name: "Adobe" });

    expect(vendor.workspaceId).toBe(bob.workspace.id);
  });

  it("ignores a workspaceId supplied by the caller", async () => {
    const scope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);

    // A caller passing someone else's workspace id — the shape the type system rejects,
    // reproduced here as an untyped payload the way a bad request body would arrive.
    const [vendor] = await scope.insert(vendors, {
      name: "Smuggled",
      workspaceId: alice.workspace.id,
    } as never);

    expect(vendor.workspaceId).toBe(bob.workspace.id);
  });

  it("cannot update another workspace's row", async () => {
    const [aliceVendor] = await (
      await openWorkspace(h.db, alice.user.id, alice.workspace.id)
    ).insert(vendors, { name: "Alice's vendor" });

    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);
    const updated = await bobScope.update(
      vendors,
      { name: "hijacked" },
      eq(vendors.id, aliceVendor.id),
    );

    expect(updated).toHaveLength(0);

    const [unchanged] = await h.db.select().from(vendors).where(eq(vendors.id, aliceVendor.id));
    expect(unchanged.name).toBe("Alice's vendor");
  });

  it("cannot delete another workspace's row", async () => {
    const [aliceVendor] = await (
      await openWorkspace(h.db, alice.user.id, alice.workspace.id)
    ).insert(vendors, { name: "Keep me" });

    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);
    expect(await bobScope.delete(vendors, eq(vendors.id, aliceVendor.id))).toBe(0);

    const rows = await h.db.select().from(vendors).where(eq(vendors.id, aliceVendor.id));
    expect(rows).toHaveLength(1);
  });
});

describe("statement intake", () => {
  // spec: docs/workflows/upload-statement.md §3a · docs/phases/phase-1.md §7 C
  //
  // C's completion criterion is that "account lookup provably never leaves the workspace".
  // These are that proof.
  it("keeps one workspace's statements out of another's", async () => {
    const aliceScope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);
    const store = new FakeDocumentStore();

    const { results } = await intakeBatch(
      aliceScope,
      store,
      [new File(["Date,Amount\n"], "march.csv", { type: "text/csv" })],
      async () => {},
    );
    const statementId = results[0].statementId!;

    // Bob knows the id — it is a uuid in a URL, not a secret — and it buys him nothing.
    await expect(
      bobScope.select(bankStatements, eq(bankStatements.id, statementId)),
    ).resolves.toEqual([]);
    // Nor can he bind it to an account of his own.
    await expect(
      bobScope.update(bankStatements, { state: "PARSING" }, eq(bankStatements.id, statementId)),
    ).resolves.toEqual([]);
  });

  it("does not match an account identifier belonging to another workspace", async () => {
    // The same business banking with the same bank, in two workspaces. Step 3a: "An
    // account identifier appearing in another Workspace is not a match and must not be
    // reported to the user in any form."
    const aliceScope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);

    const identifier = "XXXX9999";
    await aliceScope.insert(bankAccounts, {
      bankName: "HDFC Bank",
      accountIdentifier: identifier,
      currency: "INR",
    });

    // Bob's lookup for the very same identifier finds nothing...
    await expect(
      bobScope.select(bankAccounts, eq(bankAccounts.accountIdentifier, identifier)),
    ).resolves.toEqual([]);

    // ...so he creates his own, and the unique index does not collide across workspaces.
    const [bobAccount] = await bobScope.insert(bankAccounts, {
      bankName: "HDFC Bank",
      accountIdentifier: identifier,
      currency: "INR",
    });
    expect(bobAccount.workspaceId).toBe(bob.workspace.id);
  });
});

describe("matching", () => {
  // spec: docs/phases/phase-1.md §7 G · docs/decisions/0011
  //
  // The attacks themselves live in `tests/matching/isolation.test.ts`, which enumerates
  // every scoped table the feature writes to. This is the entry this file requires for
  // every workspace-scoped feature, and it covers the table matching added.
  it("keeps one workspace's match candidates out of another's", async () => {
    // Seeded in Bob's workspace: this file shares one database across its tests, and the
    // generic check below asserts Alice's scope reads no transactions at all.
    const aliceScope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    const bobScope = await openWorkspace(h.db, bob.user.id, bob.workspace.id);

    const [account] = await bobScope.select(bankAccounts);
    const [transaction] = await bobScope.insert(canonicalTransactions, {
      bankAccountId: account.id,
      valueDate: "2026-04-14",
      amountMinor: 2000n,
      direction: "DEBIT",
      currency: "USD",
      description: "ANTHROPIC",
      descriptionNormalized: "anthropic",
      occurrenceIndex: 0,
    });
    const [invoice] = await bobScope.insert(invoices, { invoiceNumber: "INV-1" });
    const [candidate] = await bobScope.insert(invoiceMatchCandidates, {
      invoiceId: invoice.id,
      canonicalTransactionId: transaction.id,
      rank: 0,
      evidence: [],
    });

    // Alice knows the id and it buys her nothing -- not the evidence, not the amounts.
    await expect(
      aliceScope.select(invoiceMatchCandidates, eq(invoiceMatchCandidates.id, candidate.id)),
    ).resolves.toEqual([]);
    // Nor can she rewrite what another workspace was shown.
    await expect(
      aliceScope.update(
        invoiceMatchCandidates,
        { modelVerdict: "SAME" },
        eq(invoiceMatchCandidates.id, candidate.id),
      ),
    ).resolves.toEqual([]);
  });
});

describe("listing workspaces", () => {
  it("returns only the user's own", async () => {
    const forAlice = await listWorkspaces(h.db, alice.user.id);
    const names = forAlice.map((w) => w.name).sort();

    expect(names).toEqual(["Alice Consulting", "Alice Traders"]);
  });
});

describe("every workspace-scoped table", () => {
  it("carries a workspaceId column", async () => {
    const { workspaceScopedTables } = await import("../../src/db/workspace-scope");

    for (const table of workspaceScopedTables) {
      expect(table.workspaceId, `${getTableName(table)} is missing workspaceId`).toBeDefined();
    }
  });

  it("is reachable only through a scope", async () => {
    // canonicalTransactions is in the list, so it must be filterable by workspace.
    const scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
    await expect(scope.select(canonicalTransactions)).resolves.toEqual([]);
  });
});
