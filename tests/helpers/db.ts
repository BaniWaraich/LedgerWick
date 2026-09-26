/**
 * Test database.
 *
 * PGlite is real Postgres compiled to WASM, running in-process. It needs no Docker
 * daemon and no service container, so schema tests run identically on a laptop and in CI.
 *
 * The migrations applied here are the same files that run against Neon — the point is
 * to test the constraints that actually ship, not a re-declaration of them.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import type { Database } from "../../src/db/client";
import * as schema from "../../src/db/schema";

export type TestDb = {
  db: Database;
  close: () => Promise<void>;
};

/** A fresh, migrated, empty database. Each test file gets its own. */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  await migrate(db, { migrationsFolder: "./migrations" });

  return {
    // PGlite and postgres-js drivers differ in their type brand but expose the same query
    // surface the application uses.
    db: db as unknown as Database,
    close: () => client.close(),
  };
}

let seq = 0;

/** A user and a workspace, ready to use. */
export async function seedWorkspace(db: Database, name = "Test Business") {
  seq += 1;
  // Deliberately not a UUID. `users.id` is whatever the auth adapter generates, and a
  // test that only ever seeds UUIDs would not notice the column narrowing back.
  const [user] = await db
    .insert(schema.users)
    .values({
      id: `user_${seq}_${crypto.randomUUID().slice(0, 8)}`,
      email: `owner${seq}@example.com`,
    })
    .returning();

  const [workspace] = await db
    .insert(schema.workspaces)
    .values({ ownerId: user.id, name })
    .returning();

  return { user, workspace };
}

/** A bank account in the given workspace. */
export async function seedBankAccount(db: Database, workspaceId: string) {
  const [account] = await db
    .insert(schema.bankAccounts)
    .values({
      workspaceId,
      bankName: "HDFC Bank",
      accountIdentifier: "XXXX1234",
      accountType: "current",
      currency: "INR",
    })
    .returning();
  return account;
}

/**
 * Assert that a write violated a unique constraint.
 *
 * Drizzle wraps driver errors and its `message` is the failed SQL, so matching on text
 * gives a test that passes for any failure at all. Postgres SQLSTATE 23505 is
 * unique_violation specifically, and the optional `constraint` pins down which one — so
 * the test fails if the right error arrives from the wrong index.
 */
export async function expectUniqueViolation(
  fn: () => Promise<unknown>,
  constraint?: string,
): Promise<void> {
  await expectViolation(fn, "23505", "unique_violation", constraint);
}

/**
 * Assert that a write violated a check constraint: SQLSTATE 23514, pinned to the named
 * constraint for the same reason `expectUniqueViolation` pins its index.
 */
export async function expectCheckViolation(
  fn: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  await expectViolation(fn, "23514", "check_violation", constraint);
}

async function expectViolation(
  fn: () => Promise<unknown>,
  code: string,
  label: string,
  constraint?: string,
): Promise<void> {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }

  if (!error) throw new Error(`expected a ${label}, but the write succeeded`);

  // The driver error is on `cause`; PGlite and postgres-js both expose code/constraint.
  const pg = ((error as { cause?: unknown }).cause ?? error) as {
    code?: string;
    constraint_name?: string;
    constraint?: string;
  };

  if (pg.code !== code) {
    throw new Error(
      `expected SQLSTATE ${code} (${label}), got ${pg.code ?? "no code"}: ${String(error)}`,
    );
  }

  if (constraint) {
    const actual = pg.constraint_name ?? pg.constraint;
    if (actual !== constraint) {
      throw new Error(`expected violation of ${constraint}, got ${actual ?? "unknown constraint"}`);
    }
  }
}
