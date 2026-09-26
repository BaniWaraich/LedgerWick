/**
 * Feature J, end to end: from choosing to connect a mailbox to a connection that holds
 * nothing it should not, and back out again.
 *
 * spec: docs/workflows/connect-gmail.md · docs/phases/phase-1.md §7J
 *
 * Runs the same two functions the route handlers call, against a real database, with only
 * Google scripted. Written as one story per scenario because the properties are about
 * sequence -- a reconnect is only meaningful after a connect -- and a reader should be able
 * to follow the lifecycle top to bottom.
 */

import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { gmailConnections, supportingDocuments, workspaces } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { isGoogleGrantHeldElsewhere } from "../../src/db/google-grants";
import { SIGN_IN_SCOPES } from "../../src/auth/google";
import { FakeGoogle, grantResponse, json } from "./fake-google";

vi.mock("server-only", () => ({}));

const { completeConnect, startConnect } = await import("../../src/gmail/connect-flow");
const { accessTokenFor, disconnectConnection, listConnections } =
  await import("../../src/gmail/connections");
const { decryptToken } = await import("../../src/gmail/crypto");

const key = randomBytes(32);
const origin = "https://www.ledgerwick.com";
let h: TestDb;

let a: WorkspaceScope;
let b: WorkspaceScope;
let outsider: WorkspaceScope;

beforeAll(async () => {
  h = await createTestDb();

  // U owns two businesses, A and B. V owns a third and neither of U's.
  const u = await seedWorkspace(h.db, "A — Traders");
  a = await openWorkspace(h.db, u.user.id, u.workspace.id);
  const [second] = await h.db
    .insert(workspaces)
    .values({ ownerId: u.user.id, name: "B — Consulting" })
    .returning();
  b = await openWorkspace(h.db, u.user.id, second.id);
  const v = await seedWorkspace(h.db, "V — Holdings");
  outsider = await openWorkspace(h.db, v.user.id, v.workspace.id);
});

afterAll(async () => {
  await h.close();
});

/** The user clicks Connect in `scope`, consents on Google as `account`, and comes back. */
async function connect(
  scope: WorkspaceScope,
  account: { sub: string; email: string; refreshToken: string; scope?: string },
  google = new FakeGoogle(),
) {
  const { authorizationUrl, pendingCookie } = startConnect(scope, {
    client: google.client,
    origin,
  });
  const state = new URL(authorizationUrl).searchParams.get("state")!;
  google.respond(grantResponse(account));

  const params = new URLSearchParams({ state, code: `4/code-for-${account.sub}` });
  const outcome = await completeConnect({
    params,
    pendingCookie,
    sessionUserId: scope.userId,
    openScope: (workspaceId) => openWorkspace(h.db, scope.userId, workspaceId),
    client: google.client,
    origin,
    key,
  });
  return { outcome, authorizationUrl, pendingCookie, params, google };
}

async function rowsOf(scope: WorkspaceScope) {
  return h.db
    .select()
    .from(gmailConnections)
    .where(eq(gmailConnections.workspaceId, scope.workspaceId));
}

const S1 = { sub: "4000000001", email: "finance@co.com" };
const S2 = { sub: "4000000002", email: "founder@gmail.com" };
const grantHeldElsewhere = (sub: string, except: string) =>
  isGoogleGrantHeldElsewhere(h.db, sub, except);

describe("AT-1: connecting mailboxes", () => {
  it("never asks for mail at sign-in", () => {
    expect(SIGN_IN_SCOPES.join(" ")).not.toMatch(/gmail|googleapis/);
  });

  it("asks for read-only mail, only when the user connects", async () => {
    const google = new FakeGoogle();
    const { authorizationUrl } = startConnect(a, { client: google.client, origin });
    const params = new URL(authorizationUrl).searchParams;

    expect(params.get("scope")).toBe("openid email https://www.googleapis.com/auth/gmail.readonly");
    expect(params.get("redirect_uri")).toBe(`${origin}/api/gmail/callback`);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(google.calls).toEqual([]);
  });

  it("records a connected mailbox in the workspace it was connected from", async () => {
    const { outcome } = await connect(a, { ...S1, refreshToken: "1//s1-in-a" });

    expect(outcome).toMatchObject({
      kind: "connected",
      restored: false,
      connection: { email: S1.email, state: "CONNECTED" },
    });

    const rows = await rowsOf(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].googleSubject).toBe(S1.sub);
    expect(rows[0].grantedScopes).toContain("gmail.readonly");
    expect(rows[0].encryptedRefreshToken).not.toContain("1//s1-in-a");
    expect(
      decryptToken(
        rows[0].encryptedRefreshToken!,
        { workspaceId: a.workspaceId, googleSubject: S1.sub },
        key,
      ),
    ).toBe("1//s1-in-a");
  });

  it("shows the connection without its credentials, and only to its workspace", async () => {
    const listed = await listConnections(a);

    expect(listed.map((c) => [c.email, c.state])).toEqual([[S1.email, "CONNECTED"]]);
    expect(JSON.stringify(listed)).not.toMatch(/1\/\/|v1:|token/i);
    expect(await listConnections(b)).toEqual([]);
  });

  it("refuses to replay a callback once its attempt is spent", async () => {
    // The route clears the attempt's cookie on every callback, so a replay arrives
    // without one.
    const first = await connect(a, { ...S1, refreshToken: "1//again" });
    const replay = await completeConnect({
      params: first.params,
      pendingCookie: undefined,
      sessionUserId: a.userId,
      openScope: (id) => openWorkspace(h.db, a.userId, id),
      client: first.google.client,
      origin,
      key,
    });

    expect(replay).toEqual({ kind: "failed", reason: "invalid_state" });
    expect(await rowsOf(a)).toHaveLength(1);
  });

  it("refuses a consent that left out the mail permission, recording nothing", async () => {
    const { outcome } = await connect(a, {
      sub: "4000000009",
      email: "unticked@co.com",
      refreshToken: "1//x",
      scope: "openid email",
    });

    expect(outcome).toEqual({ kind: "failed", reason: "scope_not_granted" });
    expect(await rowsOf(a)).toHaveLength(1);
  });

  it("keeps a second mailbox beside the first", async () => {
    await connect(a, { ...S2, refreshToken: "1//s2-in-a" });

    const rows = await rowsOf(a);
    expect(rows.map((r) => r.state)).toEqual(["CONNECTED", "CONNECTED"]);
  });

  it("connects the same mailbox to another business as a separate connection", async () => {
    await connect(b, { ...S1, refreshToken: "1//s1-in-b" });

    const [inA] = (await rowsOf(a)).filter((r) => r.googleSubject === S1.sub);
    const [inB] = await rowsOf(b);
    expect(inB.id).not.toBe(inA.id);
    expect(inB.encryptedRefreshToken).not.toBe(inA.encryptedRefreshToken);
  });

  it("will not let someone else's session complete an attempt into A", async () => {
    const google = new FakeGoogle();
    const { authorizationUrl, pendingCookie } = startConnect(a, { client: google.client, origin });
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const before = await rowsOf(a);

    const outcome = await completeConnect({
      params: new URLSearchParams({ state, code: "4/stolen" }),
      pendingCookie,
      sessionUserId: outsider.userId,
      openScope: (id) => openWorkspace(h.db, outsider.userId, id),
      client: google.client,
      origin,
      key,
    });

    expect(outcome).toEqual({ kind: "failed", reason: "invalid_state" });
    expect(google.calls).toEqual([]);
    expect(await rowsOf(a)).toEqual(before);
  });
});

describe("AT-2: reauthorizing, disconnecting and connecting again", () => {
  const s1In = async (scope: WorkspaceScope) =>
    (await rowsOf(scope)).find((r) => r.googleSubject === S1.sub)!;

  it("moves only the broken connection to NEEDS_REAUTH", async () => {
    const google = new FakeGoogle().respond(json(400, { error: "invalid_grant" }));

    await expect(accessTokenFor(a, (await s1In(a)).id, google.client, key)).rejects.toMatchObject({
      state: "NEEDS_REAUTH",
    });

    expect((await s1In(a)).state).toBe("NEEDS_REAUTH");
    expect((await rowsOf(a)).find((r) => r.googleSubject === S2.sub)!.state).toBe("CONNECTED");
    expect((await s1In(b)).state).toBe("CONNECTED");
  });

  it("restores the same connection when the user reconnects", async () => {
    const before = await s1In(a);

    const { outcome } = await connect(a, { ...S1, refreshToken: "1//s1-reauthorized" });

    expect(outcome).toMatchObject({ kind: "connected", restored: true });
    const after = await s1In(a);
    expect(after.id).toBe(before.id);
    expect(after.state).toBe("CONNECTED");
    expect(after.encryptedRefreshToken).not.toBe(before.encryptedRefreshToken);
  });

  it("disconnects without revoking a grant B still uses, and keeps what was retrieved", async () => {
    const connection = await s1In(a);
    const [document] = await a.insert(supportingDocuments, {
      storageRef: `workspaces/${a.workspaceId}/documents/d1/receipt.pdf`,
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      source: "GMAIL",
      sourceMetadata: { connectionId: connection.id, messageId: "m1", attachmentId: "a1" },
    });
    const google = new FakeGoogle();

    const { revocation } = await disconnectConnection(a, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    expect(revocation).toBe("shared");
    expect(google.revokes()).toEqual([]);
    const after = await s1In(a);
    expect(after).toMatchObject({ state: "DISCONNECTED", encryptedRefreshToken: null });
    expect(after.disconnectedAt).toBeInstanceOf(Date);
    expect(await a.select(supportingDocuments, eq(supportingDocuments.id, document.id))).toEqual([
      document,
    ]);
    expect((await s1In(b)).state).toBe("CONNECTED");
  });

  it("revokes the grant with google when the last connection holding it goes", async () => {
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));

    const { revocation } = await disconnectConnection(b, (await s1In(b)).id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    expect(revocation).toBe("revoked");
    expect(google.revokes().map((c) => c.form.get("token"))).toEqual(["1//s1-in-b"]);
  });

  it("brings the original connection back when the account is connected again", async () => {
    const original = await s1In(a);
    const count = (await rowsOf(a)).length;

    const { outcome } = await connect(a, { ...S1, refreshToken: "1//s1-back" });

    expect(outcome).toMatchObject({ kind: "connected", restored: true });
    expect((await s1In(a)).id).toBe(original.id);
    expect((await s1In(a)).state).toBe("CONNECTED");
    expect(await rowsOf(a)).toHaveLength(count);
  });
});
