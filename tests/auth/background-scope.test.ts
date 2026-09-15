/**
 * The workspace a background job is allowed to touch.
 *
 * spec: docs/architecture.md §7 · docs/definition-of-done.md
 *
 * `src/auth/background.ts` is the one door from an event payload to a `WorkspaceScope`.
 * It is deliberately thin — it binds `getDb()` to `openWorkspace` and nothing else — so
 * what is worth testing is the contract it relies on: that the workspace id travelling
 * in an event is re-checked against the user, and buys nothing on its own.
 *
 * These are written as attacks on that claim, because an event payload is more exposed
 * than a cookie: it can be replayed, edited in the Inngest dashboard, or delivered long
 * after the membership that produced it was revoked.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { workspaces } from "../../src/db/schema";
import { openWorkspace, WorkspaceAccessError } from "../../src/db/workspace-scope";

let h: TestDb;

beforeAll(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h.close();
});

describe("a job's workspace scope", () => {
  it("opens the workspace when the payload's user still owns it", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");

    const scope = await openWorkspace(h.db, alice.user.id, alice.workspace.id);

    expect(scope.workspaceId).toBe(alice.workspace.id);
    expect(scope.userId).toBe(alice.user.id);
  });

  it("refuses a payload naming someone else's workspace", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");
    const bob = await seedWorkspace(h.db, "Bob Supplies");

    // The shape of a tampered or misrouted event: a real user, a real workspace, and no
    // relationship between them.
    await expect(openWorkspace(h.db, bob.user.id, alice.workspace.id)).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });

  it("refuses a payload naming a workspace that no longer exists", async () => {
    const alice = await seedWorkspace(h.db, "Alice Traders");
    const deleted = alice.workspace.id;
    await h.db.delete(workspaces).where(eq(workspaces.id, deleted));

    // A queued event outliving its workspace must fail closed, not fall back to some
    // other workspace of the same user.
    await expect(openWorkspace(h.db, alice.user.id, deleted)).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  });
});
