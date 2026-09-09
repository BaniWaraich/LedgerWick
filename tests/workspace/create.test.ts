/**
 * Creating a workspace.
 *
 * spec: docs/domain-model.md §3.2, §11 · docs/phases/phase-1.md §7A
 *
 * `createWorkspace` takes `ownerId` as an argument, and the whole safety of that rests on
 * where the argument comes from: the session, in `createWorkspaceForUser`, never a form
 * field. These tests cover the rule the data layer can enforce — that a created workspace
 * belongs to exactly one user and is invisible to everyone else.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, seedBankAccount, type TestDb } from "../helpers/db";
import {
  InvalidWorkspaceNameError,
  createWorkspace,
  listWorkspaces,
  openWorkspace,
} from "../../src/db/workspace-scope";
import { bankAccounts, users } from "../../src/db/schema";
import { resolveWorkspaceScope } from "../../src/auth/workspace-resolution";

let h: TestDb;

// One database for the file; `seedUser` keeps each test's users distinct. Booting PGlite
// per test is the slowest thing in the suite and buys nothing here.
beforeAll(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h.close();
});

let seq = 0;

/** A user nobody else in this file shares. */
async function seedUser(label: string) {
  seq += 1;
  const id = `${label}_${seq}`;
  const [user] = await h.db
    .insert(users)
    .values({ id, email: `${id}@example.com` })
    .returning();
  return user;
}

describe("creating a workspace", () => {
  it("makes the creator its owner", async () => {
    const alice = await seedUser("alice");

    const workspace = await createWorkspace(h.db, alice.id, "Alice Traders");

    expect(workspace.ownerId).toBe(alice.id);
    expect(workspace.name).toBe("Alice Traders");
  });

  it("puts it in the creator's list", async () => {
    const alice = await seedUser("alice");
    const workspace = await createWorkspace(h.db, alice.id, "Alice Traders");

    expect((await listWorkspaces(h.db, alice.id)).map((w) => w.id)).toEqual([workspace.id]);
  });

  it("keeps it out of another user's list", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    await createWorkspace(h.db, alice.id, "Alice Traders");

    expect(await listWorkspaces(h.db, bob.id)).toEqual([]);
  });

  it("does not let another user open it", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const workspace = await createWorkspace(h.db, alice.id, "Alice Traders");

    await expect(openWorkspace(h.db, bob.id, workspace.id)).rejects.toThrow(
      /No accessible workspace/,
    );
  });

  it("lets one user have several", async () => {
    const alice = await seedUser("alice");
    await createWorkspace(h.db, alice.id, "Alice Traders");
    await createWorkspace(h.db, alice.id, "Alice Consulting");

    const names = (await listWorkspaces(h.db, alice.id)).map((w) => w.name).sort();
    expect(names).toEqual(["Alice Consulting", "Alice Traders"]);
  });

  it("keeps a user's own two workspaces separate", async () => {
    // The case that catches isolation written as "is this the user's data".
    const alice = await seedUser("alice");
    const trading = await createWorkspace(h.db, alice.id, "Alice Traders");
    const consulting = await createWorkspace(h.db, alice.id, "Alice Consulting");
    await seedBankAccount(h.db, trading.id);

    const consultingScope = await openWorkspace(h.db, alice.id, consulting.id);

    expect(await consultingScope.select(bankAccounts)).toEqual([]);
  });
});

describe("a workspace name", () => {
  it("is required", async () => {
    const alice = await seedUser("alice");

    await expect(createWorkspace(h.db, alice.id, "")).rejects.toThrow(InvalidWorkspaceNameError);
  });

  it("is not satisfied by whitespace", async () => {
    const alice = await seedUser("alice");

    await expect(createWorkspace(h.db, alice.id, "   \t\n ")).rejects.toThrow(
      InvalidWorkspaceNameError,
    );
  });

  it("is trimmed", async () => {
    const alice = await seedUser("alice");

    const workspace = await createWorkspace(h.db, alice.id, "  Alice Traders  ");

    expect(workspace.name).toBe("Alice Traders");
  });

  it("does not create a row when it is rejected", async () => {
    const alice = await seedUser("alice");

    await expect(createWorkspace(h.db, alice.id, "")).rejects.toThrow();

    expect(await listWorkspaces(h.db, alice.id)).toEqual([]);
  });
});

describe("a newly created workspace", () => {
  it("is resolvable as the user's only one", async () => {
    const alice = await seedUser("alice");
    const workspace = await createWorkspace(h.db, alice.id, "Alice Traders");

    const resolution = await resolveWorkspaceScope(h.db, alice.id);

    expect(resolution.kind).toBe("scope");
    if (resolution.kind !== "scope") throw new Error("unreachable");
    expect(resolution.scope.workspaceId).toBe(workspace.id);
  });

  it("does not disturb another user's resolution", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    await createWorkspace(h.db, alice.id, "Alice Traders");

    expect(await resolveWorkspaceScope(h.db, bob.id)).toEqual({ kind: "no-workspaces" });
  });
});
