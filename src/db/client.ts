/**
 * Database connection.
 *
 * Lazy on purpose: Next evaluates top-level module code at build time, and a driver that
 * throws on a missing DATABASE_URL would break `next build` in any environment where the
 * variable is not yet set.
 *
 * No Proxy wrapper — libraries that inspect the client object break in confusing,
 * error-free ways when one is in the way.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = ReturnType<typeof createDb>;

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Run `vercel env pull .env.local --yes`.");
  }
  // prepare: false is required behind a transaction-mode connection pooler, which is how
  // Supabase serves pooled connections.
  const client = postgres(url, { prepare: false });
  return drizzle(client, { schema });
}

let instance: Database | null = null;

export function getDb(): Database {
  if (!instance) instance = createDb();
  return instance;
}

/** Point the module at an existing connection. Tests use this; nothing else should. */
export function setDb(db: Database | null): void {
  instance = db;
}
