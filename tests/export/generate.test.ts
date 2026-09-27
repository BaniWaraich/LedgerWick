/**
 * Generating an export, end to end below the Inngest shell.
 *
 * spec: docs/workflows/missing-invoice-report.md §9 · docs/architecture.md §12B, §15, §16 ·
 * docs/state-machines.md §7
 * decision: docs/decisions/0017-reconciliation-export.md
 *
 * A real database and the fake store. Every claim is checked by downloading the stored
 * file through `serveExport` and opening it, so what is tested is what the user receives.
 */

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import {
  invoiceRequirements,
  reconciliationExports,
  reconciliationRuns,
} from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { recordExportFailure, requestExport } from "../../src/export/exports";
import { generateExport } from "../../src/export/generate";
import type { DocumentBody, StoredReference } from "../../src/storage/document-store";
import type { DocumentKey } from "../../src/storage/keys";
import { serveExport } from "../../src/storage/serving";
import { FakeDocumentStore } from "../storage/fake-document-store";
import { bytesOf, readRows, seedReconciliation, type Reconciliation } from "./world";

const ORIGIN = "https://app.example.com";

let h: TestDb;
let scope: WorkspaceScope;
let store: FakeDocumentStore;
let world: Reconciliation;

beforeEach(async () => {
  h = await createTestDb();
  const seed = await seedWorkspace(h.db);
  scope = new WorkspaceScope(h.db, seed.workspace.id, seed.user.id);
  store = new FakeDocumentStore();
  world = await seedReconciliation(h, scope, "ACME");
});

afterEach(async () => {
  await h.close();
});

/** Ask for an export the way the page does, with the event going nowhere. */
async function request(): Promise<string> {
  const outcome = await requestExport(scope, ORIGIN, async () => undefined);
  if (!outcome.requested) throw new Error(outcome.reason);
  return outcome.exportId;
}

async function exportRow(exportId: string) {
  return (await scope.selectOne(reconciliationExports, eq(reconciliationExports.id, exportId)))!;
}

async function download(exportId: string): Promise<Buffer> {
  const response = await serveExport(scope, store, exportId);
  expect(response.status).toBe(200);
  return bytesOf(response);
}

describe("an export", () => {
  it("is the complete reconciliation, not the queue", async () => {
    const exportId = await request();
    expect(await generateExport(scope, store, exportId, ORIGIN)).toBe("generated");

    const rows = await readRows(await download(exportId));

    expect(rows.map((row) => [row.Description, row["Document needed"], row.Status])).toEqual([
      ["ACME PAYMENT MATCHED", "Yes", "Matched"],
      ["ACME PAYMENT NOT_FOUND", "Yes", "Not found"],
      ["ACME PAYMENT NEEDS_REVIEW", "Yes", "Needs review"],
      ["ACME PAYMENT NOT_REQUIRED", "No — marked by you", "No document needed"],
      ["ACME PAYMENT NONE", "No document identified as needed", null],
      ["ACME PAYMENT ASKED", "Waiting for your answer", null],
    ]);

    const ready = await exportRow(exportId);
    expect(ready.state).toBe("READY");
    expect(ready.transactionCount).toBe(6);
  });

  it("reads its values from the database", async () => {
    const exportId = await request();
    await generateExport(scope, store, exportId, ORIGIN);

    const [matched] = await readRows(await download(exportId));
    expect(matched.Amount).toBe(100);
    expect(matched.Currency).toBe("INR");
    expect(matched.Vendor).toBe("ACME Vendor");
    expect(matched["How resolved"]).toBe("Matched automatically");
  });

  it("links the matched document into the application, never to storage", async () => {
    const exportId = await request();
    await generateExport(scope, store, exportId, ORIGIN);

    const bytes = await download(exportId);
    const rows = await readRows(bytes);

    expect(rows[0].Document).toEqual({
      text: "ACME-invoice.pdf",
      hyperlink: `${ORIGIN}/documents/${world.documentId}`,
    });
    expect(rows.slice(1).every((row) => row.Document === null)).toBe(true);
    expect(bytes.includes(world.storageRef)).toBe(false);
  });

  it("is sent as a file to save", async () => {
    const exportId = await request();
    await generateExport(scope, store, exportId, ORIGIN);

    const response = await serveExport(scope, store, exportId);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="ledgerwick-reconciliation-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("a snapshot", () => {
  it("does not change when the reconciliation does, and the next one shows the change", async () => {
    const first = await request();
    await generateExport(scope, store, first, ORIGIN);
    const before = await download(first);

    await scope.update(
      invoiceRequirements,
      {
        state: "RESOLVED",
        resolutionMethod: "USER_CONFIRMED",
        resolvedDocumentId: world.documentId,
      },
      eq(invoiceRequirements.id, world.reviewRequirementId),
    );

    const second = await request();
    await generateExport(scope, store, second, ORIGIN);

    const after = await download(first);
    expect(after.equals(before)).toBe(true);
    expect((await readRows(after))[2].Status).toBe("Needs review");

    const fresh = await readRows(await download(second));
    expect(fresh[2].Status).toBe("Matched");
    expect(fresh[2]["How resolved"]).toBe("Confirmed by you");

    const [a, b] = [await exportRow(first), await exportRow(second)];
    expect(a.id).not.toBe(b.id);
    expect(a.storageRef).not.toBe(b.storageRef);
  });

  it("is built once, however often the event is delivered", async () => {
    const exportId = await request();

    expect(await generateExport(scope, store, exportId, ORIGIN)).toBe("generated");
    const ref = (await exportRow(exportId)).storageRef;

    expect(await generateExport(scope, store, exportId, ORIGIN)).toBe("skipped");
    expect((await exportRow(exportId)).storageRef).toBe(ref);
    expect(store.size).toBe(1);
  });
});

describe("a failed generation", () => {
  class BrokenStore extends FakeDocumentStore {
    override async put(_key: DocumentKey, _body: DocumentBody): Promise<StoredReference> {
      throw new Error("store unavailable");
    }
  }

  it("throws for the workflow to retry, and leaves nothing to download", async () => {
    const exportId = await request();

    await expect(generateExport(scope, new BrokenStore(), exportId, ORIGIN)).rejects.toThrow(
      "store unavailable",
    );

    const row = await exportRow(exportId);
    expect(row.state).toBe("GENERATING");
    expect(row.storageRef).toBeNull();
    expect((await serveExport(scope, store, exportId)).status).toBe(404);
  });

  it("is recorded as failed once retries are spent, and is never downloadable", async () => {
    const exportId = await request();
    await expect(generateExport(scope, new BrokenStore(), exportId, ORIGIN)).rejects.toThrow();

    await recordExportFailure(scope, exportId);

    expect((await exportRow(exportId)).state).toBe("FAILED");
    expect((await serveExport(scope, store, exportId)).status).toBe(404);
    // A late delivery of the same event does not revive it.
    expect(await generateExport(scope, store, exportId, ORIGIN)).toBe("skipped");
  });

  it("is retried by asking again, which is a new snapshot", async () => {
    const failed = await request();
    await recordExportFailure(scope, failed);

    const retry = await request();
    await generateExport(scope, store, retry, ORIGIN);

    expect(retry).not.toBe(failed);
    expect((await exportRow(retry)).state).toBe("READY");
    expect((await readRows(await download(retry))).length).toBe(6);
  });

  it("never turns a finished export back into a failure", async () => {
    const exportId = await request();
    await generateExport(scope, store, exportId, ORIGIN);

    await recordExportFailure(scope, exportId);

    expect((await exportRow(exportId)).state).toBe("READY");
  });
});

describe("a workspace with no transactions", () => {
  it("exports a valid file with only its headers", async () => {
    const empty = await seedWorkspace(h.db, "Empty Business");
    const emptyScope = new WorkspaceScope(h.db, empty.workspace.id, empty.user.id);
    // A run that found nothing is still a run (identifying-invoices §10).
    await emptyScope.insert(reconciliationRuns, { state: "COMPLETED" });

    const outcome = await requestExport(emptyScope, ORIGIN, async () => undefined);
    if (!outcome.requested) throw new Error(outcome.reason);
    await generateExport(emptyScope, store, outcome.exportId, ORIGIN);

    const response = await serveExport(emptyScope, store, outcome.exportId);
    expect(response.status).toBe(200);
    expect(await readRows(await bytesOf(response))).toEqual([]);
  });
});
