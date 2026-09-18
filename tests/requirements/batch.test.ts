/**
 * When an upload batch counts as finished.
 *
 * spec: docs/workflows/identifying-invoices.md §4 · docs/workflows/upload-statement.md §11
 *
 * This is the rule that decides when a reconciliation run starts, and getting it wrong is
 * quiet in both directions: too eager and the run judges half an upload, too patient and it
 * never starts at all.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { batchIsSettled } from "../../src/requirements/batch";
import { createTestDb, seedBankAccount, seedWorkspace, type TestDb } from "../helpers/db";

type State = (typeof schema.statementStateEnum.enumValues)[number];

let harness: TestDb;

beforeEach(async () => {
  harness = await createTestDb();
});

afterAll(async () => {
  await harness.close();
});

interface Fixture {
  scope: WorkspaceScope;
  batch: (...states: State[]) => Promise<string>;
}

async function fixture(): Promise<Fixture> {
  const { user, workspace } = await seedWorkspace(harness.db);
  const account = await seedBankAccount(harness.db, workspace.id);
  const scope = await openWorkspace(harness.db, user.id, workspace.id);

  let sequence = 0;

  return {
    scope,
    batch: async (...states: State[]) => {
      const uploadBatchId = crypto.randomUUID();
      for (const state of states) {
        sequence += 1;
        await harness.db.insert(schema.bankStatements).values({
          workspaceId: workspace.id,
          bankAccountId: account.id,
          uploadBatchId,
          filename: `statement-${sequence}.pdf`,
          mimeType: "application/pdf",
          storageRef: `workspaces/${workspace.id}/statements/${sequence}/statement.pdf`,
          state,
        });
      }
      return uploadBatchId;
    },
  };
}

describe("a batch the system is still working on", () => {
  it.each(["UPLOADING", "IDENTIFYING", "PARSING", "VALIDATING"] as State[])(
    "is not settled while one file is %s",
    async (state) => {
      const fx = await fixture();
      const batch = await fx.batch("COMPLETED", state);

      expect(await batchIsSettled(fx.scope, batch)).toBe(false);
    },
  );
});

describe("a batch that has stopped moving", () => {
  it("is settled when every file completed", async () => {
    const fx = await fixture();
    const batch = await fx.batch("COMPLETED", "COMPLETED");

    expect(await batchIsSettled(fx.scope, batch)).toBe(true);
  });

  it("is settled when the last file failed", async () => {
    // Waiting for a success that is never coming would mean the other files in the upload
    // are never reconciled because one of them was unreadable.
    const fx = await fixture();
    const batch = await fx.batch("COMPLETED", "FAILED");

    expect(await batchIsSettled(fx.scope, batch)).toBe(true);
  });

  it("is settled when every file failed", async () => {
    const fx = await fixture();
    const batch = await fx.batch("FAILED", "FAILED");

    expect(await batchIsSettled(fx.scope, batch)).toBe(true);
  });

  it("is settled although one file is waiting for the user to pick an account", async () => {
    // NEEDS_ACCOUNT is waiting for a human, and the run is forbidden from doing that
    // (architecture.md §12C). The other four files can be reconciled now; the fifth
    // rejoins when the user picks, because binding sends it back through parsing.
    const fx = await fixture();
    const batch = await fx.batch("COMPLETED", "NEEDS_ACCOUNT");

    expect(await batchIsSettled(fx.scope, batch)).toBe(true);
  });
});

describe("a batch that is not there", () => {
  it("is not settled, because there is nothing to have settled", async () => {
    const fx = await fixture();

    expect(await batchIsSettled(fx.scope, crypto.randomUUID())).toBe(false);
  });

  it("is not settled when it belongs to another workspace", async () => {
    // A tampered event carrying someone else's batch id starts no run, because the scope
    // never returns its statements.
    const theirs = await fixture();
    const batch = await theirs.batch("COMPLETED");

    const ours = await fixture();
    expect(await batchIsSettled(ours.scope, batch)).toBe(false);
  });

  it("does not let one workspace's unfinished file hold up another's batch", async () => {
    const theirs = await fixture();
    await theirs.batch("PARSING");

    const ours = await fixture();
    const batch = await ours.batch("COMPLETED");

    expect(await batchIsSettled(ours.scope, batch)).toBe(true);
  });
});
