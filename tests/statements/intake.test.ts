/**
 * Taking an upload batch in.
 *
 * spec: docs/workflows/upload-statement.md §3, §11 · docs/phases/phase-1.md §7 C
 *
 * The properties under test are the ones phase 1 names as C's completion criteria: files
 * in one batch reach independent outcomes, the state survives the request, and the key is
 * built the one way feature B allows.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { FakeDocumentStore } from "../storage/fake-document-store";
import { bankStatements } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import type { DocumentBody, StoredReference } from "../../src/storage/document-store";
import { workspacePrefix, type DocumentKey } from "../../src/storage/keys";
import { intakeBatch, type IntakeResult } from "../../src/statements/intake";

let h: TestDb;
let scope: WorkspaceScope;

beforeAll(async () => {
  h = await createTestDb();
  const alice = await seedWorkspace(h.db, "Alice Traders");
  scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);
});

afterAll(async () => {
  await h.close();
});

function csv(name = "march.csv"): File {
  return new File(["Date,Description,Amount\n"], name, { type: "text/csv" });
}

function pdf(name = "march.pdf"): File {
  return new File([Uint8Array.from([0x25, 0x50, 0x44, 0x46])], name, {
    type: "application/pdf",
  });
}

/** A store that fails for one named file, to prove one file's failure stays its own. */
class StoreThatRefuses extends FakeDocumentStore {
  constructor(private readonly failingFilename: string) {
    super();
  }

  override put(
    key: DocumentKey,
    body: DocumentBody,
    contentType: string,
  ): Promise<StoredReference> {
    if (key.includes(this.failingFilename)) return Promise.reject(new Error("blob is down"));
    return super.put(key, body, contentType);
  }
}

/** Collects what intake asked to be identified, so the events can be asserted. */
function recorder() {
  const sent: string[] = [];
  return { sent, publish: async (id: string) => void sent.push(id) };
}

describe("an accepted file", () => {
  it("stores the bytes, records the row, and asks for identification", async () => {
    const store = new FakeDocumentStore();
    const { sent, publish } = recorder();

    const { uploadBatchId, results } = await intakeBatch(scope, store, [csv()], publish);

    expect(results).toHaveLength(1);
    expect(results[0].accepted).toBe(true);
    expect(sent).toEqual([results[0].statementId]);

    const [row] = await scope.select(
      bankStatements,
      eq(bankStatements.id, results[0].statementId!),
    );
    expect(row.state).toBe("UPLOADING");
    expect(row.filename).toBe("march.csv");
    expect(row.uploadBatchId).toBe(uploadBatchId);
    expect(row.bankAccountId).toBeNull();
  });

  it("builds a workspace-prefixed key naming the statement row", async () => {
    const store = new FakeDocumentStore();
    const { publish } = recorder();

    const { results } = await intakeBatch(scope, store, [csv()], publish);
    const [row] = await scope.select(
      bankStatements,
      eq(bankStatements.id, results[0].statementId!),
    );

    // Feature B's rule: the prefix is the key's, not the writer's to remember.
    expect(row.storageRef.startsWith(workspacePrefix(scope.workspaceId))).toBe(true);
    // The row's own id is the segment that separates two uploads of the same filename.
    expect(row.storageRef).toContain(`/statements/${row.id}/`);
    // Never the key we asked for — the store may rename it, and it did.
    expect(row.storageRef).not.toBe(
      `${workspacePrefix(scope.workspaceId)}statements/${row.id}/march.csv`,
    );
  });
});

describe("a file we cannot read", () => {
  it("is still stored, and fails with a reason the user can act on", async () => {
    const store = new FakeDocumentStore();
    const { sent, publish } = recorder();

    const spreadsheet = new File(["x"], "march.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const { results } = await intakeBatch(scope, store, [spreadsheet], publish);

    expect(results[0].accepted).toBe(false);
    expect(results[0].reason).toMatch(/PDF and CSV/);
    // Nothing is identified, but the original survives: §2.1, and the definition of done
    // forbids automated deletion.
    expect(sent).toEqual([]);

    const [row] = await scope.select(
      bankStatements,
      eq(bankStatements.id, results[0].statementId!),
    );
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toMatch(/PDF and CSV/);
    expect(await store.head(row.storageRef)).not.toBeNull();
  });

  it("accepts a .csv the browser mislabelled", async () => {
    const store = new FakeDocumentStore();
    const { publish } = recorder();

    // Windows reports this for any .csv Excel has opened. Rejecting it would turn away an
    // ordinary statement for a reason the user cannot see or fix.
    const mislabelled = new File(["Date,Amount\n"], "march.csv", {
      type: "application/vnd.ms-excel",
    });
    const { results } = await intakeBatch(scope, store, [mislabelled], publish);

    expect(results[0].accepted).toBe(true);
  });
});

describe("a batch", () => {
  it("lets its files reach different outcomes", async () => {
    const store = new FakeDocumentStore();
    const { sent, publish } = recorder();

    const { results } = await intakeBatch(
      scope,
      store,
      [pdf("hdfc-january.pdf"), new File(["notes"], "notes.txt", { type: "text/plain" }), csv()],
      publish,
    );

    expect(results.map((r: IntakeResult) => r.accepted)).toEqual([true, false, true]);
    expect(sent).toHaveLength(2);
  });

  it("groups its files under one batch id, and separates two batches", async () => {
    const store = new FakeDocumentStore();
    const { publish } = recorder();

    const first = await intakeBatch(scope, store, [csv("a.csv"), csv("b.csv")], publish);
    const second = await intakeBatch(scope, store, [csv("c.csv")], publish);

    expect(first.uploadBatchId).not.toBe(second.uploadBatchId);
    const rows = await scope.select(
      bankStatements,
      eq(bankStatements.uploadBatchId, first.uploadBatchId),
    );
    expect(rows).toHaveLength(2);
  });

  it("carries on when one file cannot be stored", async () => {
    const { sent, publish } = recorder();

    const { results } = await intakeBatch(
      scope,
      new StoreThatRefuses("broken.csv"),
      [csv("broken.csv"), csv("fine.csv")],
      publish,
    );

    expect(results[0].statementId).toBeNull();
    expect(results[0].reason).toMatch(/try uploading it again/);
    // The neighbour still landed — §3's whole point.
    expect(results[1].accepted).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("when the queue cannot be reached", () => {
  /** A publisher that refuses, the way `inngest.send` does with no dev server listening. */
  function refusing(failFor?: string) {
    const sent: string[] = [];
    return {
      sent,
      publish: async (id: string) => {
        if (failFor && !id.includes(failFor)) {
          sent.push(id);
          return;
        }
        throw new TypeError("fetch failed");
      },
    };
  }

  it("records the failure as state instead of leaving the row in UPLOADING", async () => {
    // Found in the wild. With the send outside the try, three real uploads left three rows
    // sitting in UPLOADING that nothing would ever pick up, while the batch screen polled
    // them forever. `§15`: a failure is state, never silently discarded.
    const store = new FakeDocumentStore();
    const { publish } = refusing();

    const { uploadBatchId, results } = await intakeBatch(scope, store, [csv()], publish);

    const [row] = await scope.select(
      bankStatements,
      eq(bankStatements.uploadBatchId, uploadBatchId),
    );
    expect(row.state).toBe("FAILED");
    expect(row.failureReason).toContain("couldn't start processing it");
    expect(results[0].accepted).toBe(false);
  });

  it("keeps the file, because the document was never the problem", async () => {
    // The definition of done forbids automated deletion, and re-uploading is only honest
    // advice if the original survived.
    const store = new FakeDocumentStore();
    const { publish } = refusing();

    const { uploadBatchId } = await intakeBatch(scope, store, [csv()], publish);

    const [row] = await scope.select(
      bankStatements,
      eq(bankStatements.uploadBatchId, uploadBatchId),
    );
    expect(await store.head(row.storageRef)).not.toBeNull();
  });

  it("still processes the rest of the batch", async () => {
    // §11: files in one batch reach their outcomes independently. The throw used to escape
    // the loop, so one unreachable queue meant the later files were never even stored.
    const store = new FakeDocumentStore();
    const { publish } = refusing("never-matches-anything");

    const { uploadBatchId, results } = await intakeBatch(
      scope,
      store,
      [csv("first.csv"), csv("second.csv"), csv("third.csv")],
      publish,
    );

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.filename)).toEqual(["first.csv", "second.csv", "third.csv"]);
    expect(
      await scope.select(bankStatements, eq(bankStatements.uploadBatchId, uploadBatchId)),
    ).toHaveLength(3);
  });

  it("does not fail the whole request", async () => {
    // The throw reached the route, which returned a 500 with an HTML error page -- which the
    // upload screen then reported as "we couldn't reach the server".
    const store = new FakeDocumentStore();
    const { publish } = refusing();

    await expect(intakeBatch(scope, store, [csv()], publish)).resolves.toHaveProperty(
      "uploadBatchId",
    );
  });
});
