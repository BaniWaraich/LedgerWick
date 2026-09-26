/**
 * One workspace cannot reach another's mailbox.
 *
 * spec: docs/workflows/connect-gmail.md §4, §6 · docs/architecture.md §12.4, §19 ·
 * docs/definition-of-done.md "When it touches workspace-scoped data"
 *
 * Written as attacks. A Gmail Connection is standing read access to a business's mail, so
 * every door into one is tried from the wrong workspace, and each must fail without
 * changing a byte of the victim's row.
 */

import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { gmailConnections } from "../../src/db/schema";
import {
  openWorkspace,
  WorkspaceAccessError,
  type WorkspaceScope,
} from "../../src/db/workspace-scope";
import { isGoogleGrantHeldElsewhere } from "../../src/db/google-grants";
import { FakeGoogle, grantResponse, json } from "./fake-google";

vi.mock("server-only", () => ({}));

const {
  ConnectionNotFoundError,
  accessTokenFor,
  disconnectConnection,
  getConnection,
  listConnections,
  markNeedsReauth,
  recordGrant,
} = await import("../../src/gmail/connections");
const { completeConnect, startConnect } = await import("../../src/gmail/connect-flow");

const key = randomBytes(32);
const origin = "http://localhost:3000";
let h: TestDb;

let alice: WorkspaceScope;
let mallory: WorkspaceScope;
let victimId: string;
let victimRowBefore: typeof gmailConnections.$inferSelect;

beforeAll(async () => {
  h = await createTestDb();

  const a = await seedWorkspace(h.db, "Alice Traders");
  const m = await seedWorkspace(h.db, "Mallory Holdings");
  alice = await openWorkspace(h.db, a.user.id, a.workspace.id);
  mallory = await openWorkspace(h.db, m.user.id, m.workspace.id);

  const { connection } = await recordGrant(
    alice,
    {
      googleSubject: "3000000001",
      email: "accounts@alice.co",
      grantedScopes: "openid email https://www.googleapis.com/auth/gmail.readonly",
      refreshToken: "1//alice-refresh-token",
    },
    { key },
  );
  victimId = connection.id;
  [victimRowBefore] = await h.db
    .select()
    .from(gmailConnections)
    .where(eq(gmailConnections.id, victimId));
});

afterAll(async () => {
  await h.close();
});

async function victimUnchanged() {
  const [row] = await h.db.select().from(gmailConnections).where(eq(gmailConnections.id, victimId));
  expect(row).toEqual(victimRowBefore);
}

describe("another workspace", () => {
  it("sees none of alice's connections", async () => {
    expect(await listConnections(mallory)).toEqual([]);
  });

  it("cannot read one by its id", async () => {
    await expect(getConnection(mallory, victimId)).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("cannot get an access token for it", async () => {
    const google = new FakeGoogle().respond(json(200, { access_token: "ya29.stolen" }));

    await expect(accessTokenFor(mallory, victimId, google.client, key)).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    // Not even a refresh was attempted with alice's token.
    expect(google.calls).toEqual([]);
    await victimUnchanged();
  });

  it("cannot disconnect it", async () => {
    const google = new FakeGoogle();

    await expect(
      disconnectConnection(mallory, victimId, {
        client: google.client,
        grantHeldElsewhere: (sub, except) => isGoogleGrantHeldElsewhere(h.db, sub, except),
        key,
      }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
    expect(google.revokes()).toEqual([]);
    await victimUnchanged();
  });

  it("cannot mark it as needing reauthorization", async () => {
    await expect(markNeedsReauth(mallory, victimId)).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
    await victimUnchanged();
  });

  it("connecting the same google account gets its own connection, not alice's", async () => {
    const { connection } = await recordGrant(
      mallory,
      {
        googleSubject: "3000000001",
        email: "accounts@alice.co",
        grantedScopes: "openid email https://www.googleapis.com/auth/gmail.readonly",
        refreshToken: "1//mallory-refresh-token",
      },
      { key },
    );

    expect(connection.id).not.toBe(victimId);
    await victimUnchanged();
  });
});

describe("a connect attempt", () => {
  it("cannot be completed into a workspace the signed-in user does not own", async () => {
    // Mallory starts an attempt for her own workspace, then edits the cookie to name
    // alice's. The callback re-opens the workspace for the session user and is refused.
    const google = new FakeGoogle().respond(
      grantResponse({ sub: "3000000099", email: "evil@m.co", refreshToken: "1//evil" }),
    );
    const { pendingCookie } = startConnect(mallory, { client: google.client, origin });
    const pending = JSON.parse(Buffer.from(pendingCookie, "base64url").toString("utf8"));
    const forged = Buffer.from(
      JSON.stringify({ ...pending, workspaceId: alice.workspaceId }),
    ).toString("base64url");

    await expect(
      completeConnect({
        params: new URLSearchParams({ state: pending.state, code: "4/code" }),
        pendingCookie: forged,
        sessionUserId: mallory.userId,
        openScope: (workspaceId) => openWorkspace(h.db, mallory.userId, workspaceId),
        client: google.client,
        origin,
        key,
      }),
    ).rejects.toBeInstanceOf(WorkspaceAccessError);

    expect(google.calls).toEqual([]);
    expect(await listConnections(alice)).toHaveLength(1);
    await victimUnchanged();
  });

  it("cannot be completed by a different user than the one who started it", async () => {
    const google = new FakeGoogle().respond(
      grantResponse({ sub: "3000000098", email: "x@a.co", refreshToken: "1//x" }),
    );
    const { pendingCookie } = startConnect(alice, { client: google.client, origin });
    const { state } = JSON.parse(Buffer.from(pendingCookie, "base64url").toString("utf8"));

    const outcome = await completeConnect({
      params: new URLSearchParams({ state, code: "4/code" }),
      pendingCookie,
      sessionUserId: mallory.userId,
      openScope: (workspaceId) => openWorkspace(h.db, mallory.userId, workspaceId),
      client: google.client,
      origin,
      key,
    });

    expect(outcome).toEqual({ kind: "failed", reason: "invalid_state" });
    expect(google.calls).toEqual([]);
    await victimUnchanged();
  });
});
