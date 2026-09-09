/**
 * Auth.js infrastructure tables.
 *
 * spec: docs/decisions/0006-authentication.md · docs/phases/phase-1.md §7A
 *
 * These tables are session and identity plumbing. They belong to a user, not to a
 * workspace, and phase-1.md §7A makes their absence from `workspaceScopedTables` an
 * explicit completion criterion for Feature A — so it is asserted here rather than left
 * to review.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, getTableName } from "drizzle-orm";

import { createTestDb, expectUniqueViolation, type TestDb } from "../helpers/db";
import { accounts, sessions, users, verificationTokens, workspaces } from "../../src/db/schema";
import { workspaceScopedTables } from "../../src/db/workspace-scope";

let h: TestDb;

beforeEach(async () => {
  h = await createTestDb();
});

afterEach(async () => {
  await h.close();
});

/** A signed-in user: the row set Auth.js writes on a first Google sign-in. */
async function seedSignedInUser(id: string, email: string) {
  const [user] = await h.db.insert(users).values({ id, email }).returning();
  await h.db.insert(accounts).values({
    userId: user.id,
    type: "oauth",
    provider: "google",
    // The Google `sub` claim: numeric, and emphatically not a UUID.
    providerAccountId: "104729384756102938475",
  });
  await h.db.insert(sessions).values({
    sessionToken: `session_${id}`,
    userId: user.id,
    expires: new Date(Date.now() + 86_400_000),
  });
  return user;
}

describe("the user id", () => {
  it("accepts an identifier that is not a uuid", async () => {
    const [user] = await h.db
      .insert(users)
      .values({ id: "cm4x9k2p0000abcdef123456", email: "owner@example.com" })
      .returning();

    expect(user.id).toBe("cm4x9k2p0000abcdef123456");
  });

  it("is generated when the adapter does not supply one", async () => {
    const [user] = await h.db.insert(users).values({ email: "owner@example.com" }).returning();

    expect(user.id).toBeTruthy();
  });

  it("refuses two users with the same email", async () => {
    await h.db.insert(users).values({ id: "u1", email: "owner@example.com" });

    await expectUniqueViolation(
      () => h.db.insert(users).values({ id: "u2", email: "owner@example.com" }),
      "users_email_unique",
    );
  });
});

describe("the external google identity", () => {
  it("records the sub claim against the user", async () => {
    await seedSignedInUser("u1", "owner@example.com");

    const [account] = await h.db.select().from(accounts).where(eq(accounts.userId, "u1"));

    expect(account.provider).toBe("google");
    expect(account.providerAccountId).toBe("104729384756102938475");
  });

  it("refuses the same google account twice", async () => {
    await seedSignedInUser("u1", "one@example.com");
    await h.db.insert(users).values({ id: "u2", email: "two@example.com" });

    await expectUniqueViolation(
      () =>
        h.db.insert(accounts).values({
          userId: "u2",
          type: "oauth",
          provider: "google",
          providerAccountId: "104729384756102938475",
        }),
      "accounts_provider_provider_account_id_pk",
    );
  });
});

describe("deleting a user", () => {
  it("takes their accounts, sessions and workspaces with them", async () => {
    await seedSignedInUser("u1", "owner@example.com");
    await h.db.insert(workspaces).values({ ownerId: "u1", name: "Alice Traders" });

    await h.db.delete(users).where(eq(users.id, "u1"));

    expect(await h.db.select().from(accounts)).toEqual([]);
    expect(await h.db.select().from(sessions)).toEqual([]);
    expect(await h.db.select().from(workspaces)).toEqual([]);
  });
});

describe("auth.js tables", () => {
  // spec: docs/phases/phase-1.md §7A — "Auth.js tables exist and are absent from
  // `workspaceScopedTables`." A single missing filter is a data leak, but so is a table
  // wrongly declared scoped: `scope.select` would filter on a column that does not exist.
  it("are absent from the workspace-scoped tables", () => {
    const scoped = workspaceScopedTables.map((t) => getTableName(t));

    for (const table of [users, accounts, sessions, verificationTokens]) {
      expect(scoped).not.toContain(getTableName(table));
    }
  });

  it("carry no workspace id to be scoped by", () => {
    for (const table of [users, accounts, sessions, verificationTokens]) {
      expect(table).not.toHaveProperty("workspaceId");
    }
  });
});
