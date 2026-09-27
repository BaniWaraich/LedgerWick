/**
 * The reconciliation_exports table's own rule.
 *
 * spec: docs/state-machines.md §7 · docs/decisions/0017-reconciliation-export.md
 *
 * "A failed generation never looks like a download" is a constraint, so it is asserted
 * against the database directly. Raw inserts on purpose: these are writes the application
 * must never be able to make, whatever path it takes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";

import { createTestDb, expectCheckViolation, seedWorkspace, type TestDb } from "../helpers/db";
import { reconciliationExports } from "../../src/db/schema";
import { workspaceScopedTables } from "../../src/db/workspace-scope";

let h: TestDb;

beforeAll(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h.close();
});

async function row(state: "GENERATING" | "READY" | "FAILED", storageRef: string | null) {
  const { user, workspace } = await seedWorkspace(h.db);
  return {
    workspaceId: workspace.id,
    requestedBy: user.id,
    state,
    storageRef,
    filename: "reconciliation.xlsx",
  };
}

describe("an export's file", () => {
  it("is refused on an export still generating", async () => {
    const values = await row("GENERATING", "workspaces/x/exports/y/reconciliation.xlsx");
    await expectCheckViolation(
      () => h.db.insert(reconciliationExports).values(values),
      "reconciliation_exports_file_check",
    );
  });

  it("is refused on an export that failed", async () => {
    const values = await row("FAILED", "workspaces/x/exports/y/reconciliation.xlsx");
    await expectCheckViolation(
      () => h.db.insert(reconciliationExports).values(values),
      "reconciliation_exports_file_check",
    );
  });

  it("is required on an export that is ready", async () => {
    const values = await row("READY", null);
    await expectCheckViolation(
      () => h.db.insert(reconciliationExports).values(values),
      "reconciliation_exports_file_check",
    );
  });

  it("is accepted when the two agree", async () => {
    const values = await row("READY", "workspaces/x/exports/y/reconciliation.xlsx");
    const [inserted] = await h.db.insert(reconciliationExports).values(values).returning();
    expect(inserted.state).toBe("READY");
  });
});

describe("the exports table", () => {
  it("is workspace-scoped, so it can only be reached through a scope", () => {
    expect(workspaceScopedTables.map((table) => getTableName(table))).toContain(
      "reconciliation_exports",
    );
  });
});
