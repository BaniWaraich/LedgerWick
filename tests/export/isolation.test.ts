/**
 * Exporting a reconciliation that is not yours.
 *
 * spec: docs/domain-model.md Rule 1 · docs/architecture.md §5.2, §19
 * required by docs/definition-of-done.md, "When it touches workspace-scoped data".
 *
 * Written as attacks, like tests/report/isolation.test.ts. Two workspaces hold equivalent
 * reconciliations; the attacker tries to get the victim's data into their own file, to
 * build the victim's export, and to download it.
 */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { reconciliationExports } from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { recordExportFailure, requestExport } from "../../src/export/exports";
import { generateExport } from "../../src/export/generate";
import { serveExport } from "../../src/storage/serving";
import { FakeDocumentStore } from "../storage/fake-document-store";
import { bytesOf, readRows, seedReconciliation, type Reconciliation } from "./world";

const ORIGIN = "https://app.example.com";

let h: TestDb;
let store: FakeDocumentStore;
let victim: WorkspaceScope;
let attacker: WorkspaceScope;
let victimWorld: Reconciliation;

async function exportFor(scope: WorkspaceScope): Promise<string> {
  const outcome = await requestExport(scope, ORIGIN, async () => undefined);
  if (!outcome.requested) throw new Error(outcome.reason);
  return outcome.exportId;
}

beforeEach(async () => {
  h = await createTestDb();
  store = new FakeDocumentStore();
  const v = await seedWorkspace(h.db, "Victim Business");
  const a = await seedWorkspace(h.db, "Attacker Business");
  victim = new WorkspaceScope(h.db, v.workspace.id, v.user.id);
  attacker = new WorkspaceScope(h.db, a.workspace.id, a.user.id);

  victimWorld = await seedReconciliation(h, victim, "VICTIM");
  await seedReconciliation(h, attacker, "ATTACKER");
});

afterEach(async () => {
  await h.close();
});

describe("the attacker's own export", () => {
  it("contains none of the victim's transactions, documents or links", async () => {
    const exportId = await exportFor(attacker);
    await generateExport(attacker, store, exportId, ORIGIN);

    const bytes = await bytesOf(await serveExport(attacker, store, exportId));
    const rows = await readRows(bytes);

    expect(rows).toHaveLength(6);
    expect(rows.every((row) => String(row.Description).startsWith("ATTACKER"))).toBe(true);
    for (const description of victimWorld.descriptions) {
      expect(bytes.includes(description)).toBe(false);
    }
    expect(bytes.includes(victimWorld.documentId)).toBe(false);
    expect(bytes.includes("VICTIM")).toBe(false);
  });
});

describe("the victim's export", () => {
  let victimExport: string;

  beforeEach(async () => {
    victimExport = await exportFor(victim);
  });

  it("cannot be built by the attacker's workflow", async () => {
    // An edited event: the attacker's identity, the victim's export id.
    expect(await generateExport(attacker, store, victimExport, ORIGIN)).toBe("skipped");

    const [row] = await victim.select(
      reconciliationExports,
      eq(reconciliationExports.id, victimExport),
    );
    expect(row.state).toBe("GENERATING");
    expect(store.size).toBe(0);
  });

  it("cannot be downloaded by the attacker, and looks exactly like one that does not exist", async () => {
    await generateExport(victim, store, victimExport, ORIGIN);
    expect((await serveExport(victim, store, victimExport)).status).toBe(200);

    const stolen = await serveExport(attacker, store, victimExport);
    const missing = await serveExport(attacker, store, crypto.randomUUID());

    expect(stolen.status).toBe(404);
    expect(await stolen.text()).toBe(await missing.text());
  });

  it("cannot be failed by the attacker", async () => {
    await recordExportFailure(attacker, victimExport);

    const [row] = await victim.select(
      reconciliationExports,
      eq(reconciliationExports.id, victimExport),
    );
    expect(row.state).toBe("GENERATING");
  });

  it("is not among the attacker's exports", async () => {
    const theirs = await attacker.select(reconciliationExports);
    expect(theirs.map((row) => row.id)).not.toContain(victimExport);
  });
});
