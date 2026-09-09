/**
 * Resolving the workspace for a request.
 *
 * spec: docs/decisions/0006-authentication.md · docs/definition-of-done.md
 *
 * The rule under test is that a workspace id arriving from the client is never trusted by
 * itself. `candidateId` here stands for exactly that untrusted value — a cookie, or a
 * route parameter — so these are written as attacks: each one supplies an id the user
 * should not be able to use and asserts it buys nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";
import { bankAccounts, users, workspaces } from "../../src/db/schema";
import { WorkspaceAccessError } from "../../src/db/workspace-scope";
import { resolveWorkspaceScope } from "../../src/auth/workspace-resolution";

let h: TestDb;

beforeEach(async () => {
  h = await createTestDb();
});

afterEach(async () => {
  await h.close();
});

describe("with a workspace id from the client", () => {
  it("opens it when the user owns it", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");

    const resolution = await resolveWorkspaceScope(h.db, alice.user.id, alice.workspace.id);

    expect(resolution.kind).toBe("scope");
    if (resolution.kind !== "scope") throw new Error("unreachable");
    expect(resolution.scope.workspaceId).toBe(alice.workspace.id);
  });

  it("refuses one belonging to someone else", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");
    const bob = await seedWorkspace(h.db, "Bob Industries");

    await expect(resolveWorkspaceScope(h.db, alice.user.id, bob.workspace.id)).rejects.toThrow(
      WorkspaceAccessError,
    );
  });

  it("refuses one that does not exist, indistinguishably", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");
    const bob = await seedWorkspace(h.db, "Bob Industries");
    const absent = "00000000-0000-0000-0000-000000000000";

    const notMine = await resolveWorkspaceScope(h.db, alice.user.id, bob.workspace.id).catch(
      (e: Error) => e.message,
    );
    const notReal = await resolveWorkspaceScope(h.db, alice.user.id, absent).catch(
      (e: Error) => e.message,
    );

    // Different wording here would tell an attacker which workspace ids exist.
    expect(notMine).toBe(`No accessible workspace ${bob.workspace.id}`);
    expect(notReal).toBe(`No accessible workspace ${absent}`);
  });

  it("does not reach another workspace's data through an accepted scope", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");
    const bob = await seedWorkspace(h.db, "Bob Industries");
    await seedBankAccount(h.db, bob.workspace.id);

    const resolution = await resolveWorkspaceScope(h.db, alice.user.id, alice.workspace.id);
    if (resolution.kind !== "scope") throw new Error("unreachable");

    // Bob's account exists, and Alice's scope cannot see it even by asking for it by id.
    const [bobAccount] = await h.db
      .select()
      .from(bankAccounts)
      .where(eq(bankAccounts.workspaceId, bob.workspace.id));

    expect(bobAccount).toBeDefined();
    expect(await resolution.scope.select(bankAccounts)).toEqual([]);
    expect(
      await resolution.scope.selectOne(bankAccounts, eq(bankAccounts.id, bobAccount.id)),
    ).toBeNull();
  });
});

describe("with no workspace id from the client", () => {
  it("reports that a new user has none", async () => {
    const [user] = await h.db
      .insert(users)
      .values({ id: "new_user", email: "new@example.com" })
      .returning();

    expect(await resolveWorkspaceScope(h.db, user.id)).toEqual({ kind: "no-workspaces" });
  });

  it("adopts the only workspace without asking", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");

    const resolution = await resolveWorkspaceScope(h.db, alice.user.id);

    expect(resolution.kind).toBe("scope");
    if (resolution.kind !== "scope") throw new Error("unreachable");
    expect(resolution.scope.workspaceId).toBe(alice.workspace.id);
  });

  it("asks which one when the user has several", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");
    await h.db.insert(workspaces).values({ ownerId: alice.user.id, name: "Alice Consulting" });

    const resolution = await resolveWorkspaceScope(h.db, alice.user.id);

    expect(resolution.kind).toBe("choose");
    if (resolution.kind !== "choose") throw new Error("unreachable");
    expect(resolution.workspaces.map((w) => w.name).sort()).toEqual([
      "Alice Consulting",
      "Alice Traders",
    ]);
  });

  it("offers no workspace belonging to another user", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");
    await h.db.insert(workspaces).values({ ownerId: alice.user.id, name: "Alice Consulting" });
    const bob = await seedWorkspace(h.db, "Bob Industries");

    const resolution = await resolveWorkspaceScope(h.db, alice.user.id);
    if (resolution.kind !== "choose") throw new Error("unreachable");

    expect(resolution.workspaces.map((w) => w.id)).not.toContain(bob.workspace.id);
  });
});
