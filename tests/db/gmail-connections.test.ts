/**
 * The gmail_connections table's own rules.
 *
 * spec: docs/workflows/connect-gmail.md §4, §6, §9 · docs/state-machines.md §6
 *
 * Two of feature J's guarantees are constraints rather than code paths, so they are
 * asserted against the database directly: a disconnected row holds no credentials and a
 * live one always does, and one Google account has one row per workspace for its whole
 * life. Written as raw inserts on purpose -- these are the writes the application must
 * never be able to make, whatever path it takes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName } from "drizzle-orm";

import {
  createTestDb,
  expectCheckViolation,
  expectUniqueViolation,
  seedWorkspace,
  type TestDb,
} from "../helpers/db";
import { gmailConnections } from "../../src/db/schema";
import { workspaceScopedTables } from "../../src/db/workspace-scope";

let h: TestDb;

beforeAll(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h.close();
});

let seq = 0;

/** A Google `sub` no other test here shares. */
function sub() {
  seq += 1;
  return `1182736450918273${String(seq).padStart(5, "0")}`;
}

function row(workspaceId: string, googleSubject: string) {
  return {
    workspaceId,
    googleSubject,
    email: `mailbox${seq}@example.com`,
    state: "CONNECTED" as const,
    grantedScopes: "openid email https://www.googleapis.com/auth/gmail.readonly",
    encryptedRefreshToken: "v1:iv:ciphertext:tag",
    connectedAt: new Date(),
  };
}

describe("a gmail connection's credentials", () => {
  it("are refused on a disconnected connection", async () => {
    const { workspace } = await seedWorkspace(h.db);

    await expectCheckViolation(
      () =>
        h.db
          .insert(gmailConnections)
          .values({ ...row(workspace.id, sub()), state: "DISCONNECTED" }),
      "gmail_connections_credentials_check",
    );
  });

  it("are required on a connected one", async () => {
    const { workspace } = await seedWorkspace(h.db);

    await expectCheckViolation(
      () =>
        h.db
          .insert(gmailConnections)
          .values({ ...row(workspace.id, sub()), encryptedRefreshToken: null }),
      "gmail_connections_credentials_check",
    );
  });

  it("are required on one that needs reauthorization", async () => {
    const { workspace } = await seedWorkspace(h.db);

    await expectCheckViolation(
      () =>
        h.db.insert(gmailConnections).values({
          ...row(workspace.id, sub()),
          state: "NEEDS_REAUTH",
          encryptedRefreshToken: null,
        }),
      "gmail_connections_credentials_check",
    );
  });

  it("cannot be left behind by a disconnect that forgets them", async () => {
    const { workspace } = await seedWorkspace(h.db);
    const [connection] = await h.db
      .insert(gmailConnections)
      .values(row(workspace.id, sub()))
      .returning();

    await expectCheckViolation(
      () =>
        h.db
          .update(gmailConnections)
          .set({ state: "DISCONNECTED" })
          .where(eq(gmailConnections.id, connection.id)),
      "gmail_connections_credentials_check",
    );
  });
});

describe("one google account in one workspace", () => {
  it("has exactly one connection", async () => {
    const { workspace } = await seedWorkspace(h.db);
    const googleSubject = sub();
    await h.db.insert(gmailConnections).values(row(workspace.id, googleSubject));

    await expectUniqueViolation(
      () => h.db.insert(gmailConnections).values(row(workspace.id, googleSubject)),
      "gmail_connections_identity_idx",
    );
  });

  it("still has exactly one once disconnected", async () => {
    // spec: connect-gmail §9 -- reconnecting restores; it never creates a second.
    const { workspace } = await seedWorkspace(h.db);
    const googleSubject = sub();
    await h.db.insert(gmailConnections).values({
      ...row(workspace.id, googleSubject),
      state: "DISCONNECTED",
      encryptedRefreshToken: null,
    });

    await expectUniqueViolation(
      () => h.db.insert(gmailConnections).values(row(workspace.id, googleSubject)),
      "gmail_connections_identity_idx",
    );
  });

  it("is a separate connection in each of two workspaces", async () => {
    // spec: connect-gmail §4 -- the same address in two workspaces is two records.
    const first = await seedWorkspace(h.db);
    const second = await seedWorkspace(h.db);
    const googleSubject = sub();

    await h.db.insert(gmailConnections).values(row(first.workspace.id, googleSubject));
    await h.db.insert(gmailConnections).values(row(second.workspace.id, googleSubject));

    const rows = await h.db
      .select()
      .from(gmailConnections)
      .where(eq(gmailConnections.googleSubject, googleSubject));
    expect(rows.map((r) => r.workspaceId).sort()).toEqual(
      [first.workspace.id, second.workspace.id].sort(),
    );
  });
});

describe("the gmail connections table", () => {
  it("is workspace-scoped", () => {
    expect(workspaceScopedTables.map((t) => getTableName(t))).toContain("gmail_connections");
  });
});
