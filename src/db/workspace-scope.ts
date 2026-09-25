/**
 * Workspace-scoped data access.
 *
 * Isolation is enforced here, in application code, rather than by Postgres row-level
 * security (docs/architecture.md §5.2). That choice keeps authorization readable and
 * testable, and it has one consequence that shapes this whole file:
 *
 *   **A single forgotten workspace filter is a data leak, with nothing behind it.**
 *
 * So the workspace is not something a caller remembers to pass. It is the object you must
 * hold in order to reach the data at all. There is no exported helper here that reads a
 * workspace-scoped table without one.
 *
 * Usage:
 *
 *     const scope = await openWorkspace(db, userId, workspaceId);  // throws if not theirs
 *     const rows = await scope.select(canonicalTransactions);      // already filtered
 *     await scope.insert(vendors, { name: "Adobe" });              // workspaceId injected
 *
 * The membership check happens once, in `openWorkspace`. Everything downstream takes the
 * scope as proof it already happened.
 */

import { and, eq, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database } from "./client";
import {
  bankAccounts,
  bankStatements,
  businessKnowledge,
  canonicalTransactions,
  clarificationQuestions,
  gmailConnections,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  invoices,
  reconciliationRuns,
  statementLines,
  supportingDocuments,
  vendorAliases,
  vendors,
  workspaces,
} from "./schema";

/**
 * Every table that belongs to a workspace.
 *
 * A new workspace-scoped table must be added here, which is deliberate friction: the
 * compiler then refuses to let it be read through this module until it is listed.
 *
 * `users` and the Auth.js tables — `accounts`, `sessions`, `verificationTokens` — are
 * deliberately absent and must stay that way (docs/decisions/0006-authentication.md).
 * They belong to a user, not to a workspace, and carry no `workspaceId` to filter on.
 * `tests/db/auth-tables.test.ts` asserts the exclusion.
 */
export const workspaceScopedTables = [
  bankAccounts,
  bankStatements,
  statementLines,
  canonicalTransactions,
  vendors,
  vendorAliases,
  supportingDocuments,
  invoices,
  invoiceDocuments,
  invoiceMatchCandidates,
  invoiceRequirements,
  reconciliationRuns,
  businessKnowledge,
  clarificationQuestions,
  gmailConnections,
] as const;

export type WorkspaceScopedTable = (typeof workspaceScopedTables)[number];

/** Thrown when a user reaches for a workspace that is not theirs, or does not exist. */
export class WorkspaceAccessError extends Error {
  constructor(workspaceId: string) {
    // Deliberately identical for "absent" and "someone else's". Distinguishing them tells
    // an attacker which workspace ids exist.
    super(`No accessible workspace ${workspaceId}`);
    this.name = "WorkspaceAccessError";
  }
}

export class WorkspaceScope {
  constructor(
    private readonly db: Database,
    readonly workspaceId: string,
    readonly userId: string,
  ) {}

  /** The filter every query in this scope carries. */
  private scoped<T extends WorkspaceScopedTable>(table: T, extra?: SQL): SQL {
    const base = eq(table.workspaceId, this.workspaceId);
    return extra ? and(base, extra)! : base;
  }

  /*
   * A note on the casts in the four methods below.
   *
   * Drizzle's query-builder types are written per-table and do not generalise over a
   * union of tables, so the compiler cannot see that `table` is consistent across a call.
   * The runtime has no such problem — it reads the table object it is handed.
   *
   * The casts are therefore confined to these four bodies and never reach callers, whose
   * argument and return types are derived from the table they pass in. `as never` rather
   * than `as any`, so the escape stays narrow and the lint rule banning `any` still holds.
   */

  /**
   * Select from a workspace-scoped table. The workspace filter is not optional.
   *
   * `limit` bounds the read itself rather than the result. A caller that means "at most
   * this many" and slices afterwards has still asked the database for everything, which is
   * the part that costs, and inside a background function with a wall-clock budget the
   * difference is the whole point of asking (`src/matching/candidates.ts`).
   */
  async select<T extends WorkspaceScopedTable>(
    table: T,
    where?: SQL,
    limit?: number,
  ): Promise<T["$inferSelect"][]> {
    const query = this.db
      .select()
      .from(table as PgTable)
      .where(this.scoped(table, where));
    const rows = await (limit === undefined ? query : query.limit(limit));
    return rows as T["$inferSelect"][];
  }

  /** Select a single row, or null. */
  async selectOne<T extends WorkspaceScopedTable>(
    table: T,
    where?: SQL,
  ): Promise<T["$inferSelect"] | null> {
    const rows = await this.db
      .select()
      .from(table as PgTable)
      .where(this.scoped(table, where))
      .limit(1);
    return (rows[0] as T["$inferSelect"]) ?? null;
  }

  /**
   * Insert into a workspace-scoped table.
   *
   * `workspaceId` is injected rather than accepted, so a caller cannot write a row into
   * someone else's workspace even by passing the wrong id.
   */
  async insert<T extends WorkspaceScopedTable>(
    table: T,
    values: Omit<T["$inferInsert"], "workspaceId"> | Omit<T["$inferInsert"], "workspaceId">[],
  ): Promise<T["$inferSelect"][]> {
    const rows = (Array.isArray(values) ? values : [values]).map((v) => ({
      ...v,
      workspaceId: this.workspaceId,
    }));
    const inserted = await this.db
      .insert(table)
      .values(rows as never)
      .returning();
    return inserted as T["$inferSelect"][];
  }

  /** Update rows in this workspace. The workspace filter is applied on top of `where`. */
  async update<T extends WorkspaceScopedTable>(
    table: T,
    values: Partial<Omit<T["$inferInsert"], "workspaceId" | "id">>,
    where?: SQL,
  ): Promise<T["$inferSelect"][]> {
    const updated = await this.db
      .update(table)
      .set(values as never)
      .where(this.scoped(table, where))
      .returning();
    return updated as T["$inferSelect"][];
  }

  /** Delete rows in this workspace. */
  async delete<T extends WorkspaceScopedTable>(table: T, where?: SQL): Promise<number> {
    const rows = await this.db.delete(table).where(this.scoped(table, where)).returning();
    return rows.length;
  }
}

/**
 * Verify the user may act in this workspace, then hand back the scope.
 *
 * This is the only way to obtain a WorkspaceScope, so it is the only place the membership
 * rule is written — one check, not one per query.
 */
export async function openWorkspace(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceScope> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)))
    .limit(1);

  if (rows.length === 0) throw new WorkspaceAccessError(workspaceId);

  return new WorkspaceScope(db, workspaceId, userId);
}

/** The workspaces a user may open. The only unscoped read in the module, by definition. */
export async function listWorkspaces(db: Database, userId: string) {
  return db.select().from(workspaces).where(eq(workspaces.ownerId, userId));
}

/** Thrown when a workspace is asked for without a usable name. */
export class InvalidWorkspaceNameError extends Error {
  constructor() {
    super("A workspace needs a name");
    this.name = "InvalidWorkspaceNameError";
  }
}

/**
 * Create a workspace owned by `ownerId`.
 *
 * Unscoped, like `listWorkspaces`, and for the same reason: a workspace *is* the
 * boundary, so there is no scope to be inside when one is made. What keeps this safe is
 * that `ownerId` is not a caller's choice — the only caller derives it from the session,
 * and the static guard in `tests/auth/scope-is-unavoidable.test.ts` stops application
 * code reaching the unscoped client to call it with anything else.
 *
 * In V1 the owner is the only member: `docs/domain-model.md §11` — "A Workspace has
 * exactly one user in V1. There are no members, roles, or invitations."
 */
export async function createWorkspace(db: Database, ownerId: string, name: string) {
  const trimmed = name.trim();

  // Rejected here rather than in the form handler so it cannot be bypassed by a caller
  // that forgets, which is the same reasoning as the workspace filter itself.
  if (trimmed.length === 0) throw new InvalidWorkspaceNameError();

  const [workspace] = await db.insert(workspaces).values({ ownerId, name: trimmed }).returning();

  return workspace;
}
