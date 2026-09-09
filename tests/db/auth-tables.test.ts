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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName } from "drizzle-orm";

import { createTestDb, expectUniqueViolation, type TestDb } from "../helpers/db";
import { accounts, sessions, users, verificationTokens, workspaces } from "../../src/db/schema";
import { workspaceScopedTables } from "../../src/db/workspace-scope";

let h: TestDb;

// One database for the file. Booting PGlite and migrating it per test dominates the
// runtime of the whole suite, and nothing here needs an empty database -- only distinct
// rows, which `uniq` provides.
beforeAll(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h.close();
});

let seq = 0;

/** An identifier no other test in this file shares. */
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}_${seq}`;
}

/**
 * A Google `sub` no other test in this file shares.
 *
 * Numeric, because a real one is. Built from the same counter as `uniq` so two tests can
 * never derive the same value -- when they did, the seed itself raised the unique
 * violation, and the test meant to assert that violation passed for the wrong reason.
 */
function uniqSub() {
  seq += 1;
  return `1047293847561029${String(seq).padStart(5, "0")}`;
}

/** A signed-in user: the row set Auth.js writes on a first Google sign-in. */
async function seedSignedInUser(id: string, sub: string) {
  const [user] = await h.db
    .insert(users)
    .values({ id, email: `${id}@example.com` })
    .returning();
  await h.db.insert(accounts).values({
    userId: user.id,
    type: "oauth",
    provider: "google",
    // The Google `sub` claim: numeric, and emphatically not a UUID.
    providerAccountId: sub,
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
    const id = `cm4x9k2p0000abcdef${seq}`;

    const [user] = await h.db
      .insert(users)
      .values({ id, email: `${uniq("owner")}@example.com` })
      .returning();

    expect(user.id).toBe(id);
  });

  it("is generated when the adapter does not supply one", async () => {
    const [user] = await h.db
      .insert(users)
      .values({ email: `${uniq("owner")}@example.com` })
      .returning();

    expect(user.id).toBeTruthy();
  });

  it("refuses two users with the same email", async () => {
    const email = `${uniq("owner")}@example.com`;
    await h.db.insert(users).values({ id: uniq("user"), email });

    await expectUniqueViolation(
      () => h.db.insert(users).values({ id: uniq("user"), email }),
      "users_email_unique",
    );
  });
});

describe("the external google identity", () => {
  it("records the sub claim against the user", async () => {
    const id = uniq("user");
    const sub = uniqSub();
    await seedSignedInUser(id, sub);

    const [account] = await h.db.select().from(accounts).where(eq(accounts.userId, id));

    expect(account.provider).toBe("google");
    expect(account.providerAccountId).toBe(sub);
  });

  it("refuses the same google account twice", async () => {
    const sub = uniqSub();
    await seedSignedInUser(uniq("first"), sub);

    const second = uniq("second");
    await h.db.insert(users).values({ id: second, email: `${second}@example.com` });

    await expectUniqueViolation(
      () =>
        h.db.insert(accounts).values({
          userId: second,
          type: "oauth",
          provider: "google",
          providerAccountId: sub,
        }),
      "accounts_provider_provider_account_id_pk",
    );
  });
});

describe("deleting a user", () => {
  it("takes their accounts, sessions and workspaces with them", async () => {
    const id = uniq("user");
    await seedSignedInUser(id, uniqSub());
    await h.db.insert(workspaces).values({ ownerId: id, name: "Alice Traders" });

    await h.db.delete(users).where(eq(users.id, id));

    // Scoped to this user: the database is shared with the other tests in this file.
    expect(await h.db.select().from(accounts).where(eq(accounts.userId, id))).toEqual([]);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, id))).toEqual([]);
    expect(await h.db.select().from(workspaces).where(eq(workspaces.ownerId, id))).toEqual([]);
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
