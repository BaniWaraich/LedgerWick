/**
 * Every statement this business has uploaded, upload by upload.
 *
 * spec: docs/workflows/upload-statement.md §14
 *
 * The batch page answers "what happened to the files I just uploaded". This answers the
 * question a user asks a week later: what have I given you, and where did each one get to.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { statementHistory } from "../../src/statements/history";
import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDb();
});

afterAll(async () => {
  await harness.close();
});

interface Fixture {
  scope: WorkspaceScope;
  accountId: string;
  upload: (
    at: string,
    files: {
      filename: string;
      state?: "COMPLETED" | "FAILED" | "NEEDS_ACCOUNT";
      bound?: boolean;
    }[],
  ) => Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const { user, workspace } = await seedWorkspace(harness.db);
  const account = await seedBankAccount(harness.db, workspace.id);
  const scope = await openWorkspace(harness.db, user.id, workspace.id);

  return {
    scope,
    accountId: account.id,
    upload: async (at, files) => {
      const uploadBatchId = crypto.randomUUID();
      for (const file of files) {
        await harness.db.insert(schema.bankStatements).values({
          workspaceId: workspace.id,
          bankAccountId: file.bound === false ? null : account.id,
          uploadBatchId,
          filename: file.filename,
          mimeType: "application/pdf",
          storageRef: `workspaces/${workspace.id}/statements/${file.filename}`,
          state: file.state ?? "COMPLETED",
          uploadedAt: new Date(at),
        });
      }
      return uploadBatchId;
    },
  };
}

describe("the statement history", () => {
  it("is empty before anything has been uploaded", async () => {
    const fx = await fixture();

    expect(await statementHistory(fx.scope)).toEqual([]);
  });

  it("groups files by the upload they arrived in, newest upload first", async () => {
    const fx = await fixture();
    const march = await fx.upload("2026-03-02T10:00:00Z", [
      { filename: "hdfc-jan.pdf" },
      { filename: "hdfc-feb.pdf" },
    ]);
    const april = await fx.upload("2026-04-05T10:00:00Z", [{ filename: "sbi-mar.pdf" }]);

    const history = await statementHistory(fx.scope);

    expect(history.map((upload) => upload.uploadBatchId)).toEqual([april, march]);
    expect(history[1].statements.map((s) => s.filename).sort()).toEqual([
      "hdfc-feb.pdf",
      "hdfc-jan.pdf",
    ]);
    expect(history[0].uploadedAt).toEqual(new Date("2026-04-05T10:00:00Z"));
  });

  it("keeps every file whatever it reached, failures included", async () => {
    // §11: the user should be able to understand the outcome of each file. A history that
    // dropped the failures would hide exactly the files they need to come back to.
    const fx = await fixture();
    await fx.upload("2026-03-02T10:00:00Z", [
      { filename: "good.pdf" },
      { filename: "unreadable.pdf", state: "FAILED" },
      { filename: "which-account.pdf", state: "NEEDS_ACCOUNT", bound: false },
    ]);

    const [upload] = await statementHistory(fx.scope);

    expect(upload.statements.map((s) => s.state).sort()).toEqual([
      "COMPLETED",
      "FAILED",
      "NEEDS_ACCOUNT",
    ]);
  });

  it("names the account each statement was bound to, and none for one still waiting", async () => {
    const fx = await fixture();
    await fx.upload("2026-03-02T10:00:00Z", [
      { filename: "bound.pdf" },
      { filename: "waiting.pdf", state: "NEEDS_ACCOUNT", bound: false },
    ]);

    const [upload] = await statementHistory(fx.scope);
    const byName = Object.fromEntries(upload.statements.map((s) => [s.filename, s.account]));

    expect(byName["bound.pdf"]).toBe("HDFC Bank XXXX1234");
    expect(byName["waiting.pdf"]).toBeNull();
  });

  it("never shows another workspace's uploads", async () => {
    const theirs = await fixture();
    await theirs.upload("2026-03-02T10:00:00Z", [{ filename: "their-statement.pdf" }]);

    const ours = await fixture();
    await ours.upload("2026-03-03T10:00:00Z", [{ filename: "our-statement.pdf" }]);

    const history = await statementHistory(ours.scope);

    expect(history.flatMap((upload) => upload.statements.map((s) => s.filename))).toEqual([
      "our-statement.pdf",
    ]);
  });
});
