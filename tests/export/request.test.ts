/**
 * Asking for an export does not build one.
 *
 * spec: docs/architecture.md §12B, §13 · docs/workflows/missing-invoice-report.md §4, §9
 * decision: docs/decisions/0017-reconciliation-export.md
 *
 * §12B: "Backend records the request, returns immediately", and the file is built by a
 * workflow. Two halves: what the request does, checked against a database; and that no
 * request-side code can reach the builder at all, checked against the source.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { reconciliationExports, reconciliationRuns } from "../../src/db/schema";
import { WorkspaceScope } from "../../src/db/workspace-scope";
import { linkOrigin, requestExport, type SendEvent } from "../../src/export/exports";

let h: TestDb;
let scope: WorkspaceScope;
let sent: Parameters<SendEvent>[0][];
const send: SendEvent = async (event) => {
  sent.push(event);
};

beforeEach(async () => {
  h = await createTestDb();
  const seed = await seedWorkspace(h.db);
  scope = new WorkspaceScope(h.db, seed.workspace.id, seed.user.id);
  sent = [];
});

afterEach(async () => {
  await h.close();
});

describe("requesting an export", () => {
  it("records it as generating and hands it to the background, once", async () => {
    await scope.insert(reconciliationRuns, { state: "COMPLETED" });

    const outcome = await requestExport(scope, "https://app.example.com", send);
    if (!outcome.requested) throw new Error(outcome.reason);

    const [row] = await scope.select(reconciliationExports);
    expect(row.id).toBe(outcome.exportId);
    expect(row.state).toBe("GENERATING");
    expect(row.storageRef).toBeNull();
    expect(row.requestedBy).toBe(scope.userId);

    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe("export/requested");
    expect(sent[0].data).toEqual({
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      exportId: outcome.exportId,
      origin: "https://app.example.com",
    });
  });

  it("is a new export every time, never a reused one", async () => {
    await scope.insert(reconciliationRuns, { state: "COMPLETED" });

    await requestExport(scope, "https://app.example.com", send);
    await requestExport(scope, "https://app.example.com", send);

    expect(await scope.select(reconciliationExports)).toHaveLength(2);
    expect(new Set(sent.map((event) => event.data.exportId)).size).toBe(2);
  });

  it("is refused before there is a reconciliation to export", async () => {
    const outcome = await requestExport(scope, "https://app.example.com", send);

    expect(outcome.requested).toBe(false);
    expect(await scope.select(reconciliationExports)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("does not leave an export generating forever when the event cannot be sent", async () => {
    await scope.insert(reconciliationRuns, { state: "COMPLETED" });

    await expect(
      requestExport(scope, "https://app.example.com", async () => {
        throw new Error("event bus unavailable");
      }),
    ).rejects.toThrow("event bus unavailable");

    const [row] = await scope.select(reconciliationExports);
    expect(row.state).toBe("FAILED");
  });
});

describe("the link origin", () => {
  it("keeps only the origin of what it is given", () => {
    expect(linkOrigin("https://www.ledgerwick.com/reconciliation?x=1")).toBe(
      "https://www.ledgerwick.com",
    );
    expect(linkOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("refuses anything that is not an http(s) origin", () => {
    expect(linkOrigin("javascript:alert(1)")).toBeNull();
    expect(linkOrigin("not a url")).toBeNull();
    expect(linkOrigin(null)).toBeNull();
  });
});

describe("where the file can be built from", () => {
  const SRC = join(__dirname, "../../src");

  function files(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) files(path, acc);
      else if (/\.tsx?$/.test(entry)) acc.push(path);
    }
    return acc;
  }

  it("is never a request: nothing under src/app imports the builder", () => {
    const offenders = files(join(SRC, "app")).filter((path) =>
      /from\s+["'][^"']*export\/(generate|workbook|rows)["']/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("is only the export workflow, which is registered to run", () => {
    const importers = files(SRC).filter((path) =>
      /from\s+["'][^"']*export\/generate["']/.test(readFileSync(path, "utf8")),
    );
    expect(importers.map((path) => path.slice(SRC.length + 1))).toEqual([
      "inngest/functions/generate-export.ts",
    ]);
    // And it is served: a function missing from the registry never runs.
    expect(readFileSync(join(SRC, "inngest/functions/index.ts"), "utf8")).toMatch(
      /^\s+generateExportFunction,$/m,
    );
  });
});
