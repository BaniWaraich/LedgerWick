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
  invoiceRequirements,
  reconciliationRuns,
  businessKnowledge,
  clarificationQuestions,
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

  /** Select from a workspace-scoped table. The workspace filter is not optional. */
  async select<T extends WorkspaceScopedTable>(
    table: T,
    where?: SQL,
  ): Promise<T["$inferSelect"][]> {
    const rows = await this.db
      .select()
      .from(table as PgTable)
      .where(this.scoped(table, where));
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
