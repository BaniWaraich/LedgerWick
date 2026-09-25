/**
 * A workspace's Gmail Connections, against a real database.
 *
 * spec: docs/workflows/connect-gmail.md §4, §6–§11 · docs/state-machines.md §6
 */

import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDb, seedWorkspace, type TestDb } from "../helpers/db";
import { gmailConnections, supportingDocuments, workspaces } from "../../src/db/schema";
import { openWorkspace, type WorkspaceScope } from "../../src/db/workspace-scope";
import { isGoogleGrantHeldElsewhere } from "../../src/db/google-grants";
import { FakeGoogle, json } from "./fake-google";

vi.mock("server-only", () => ({}));

const {
  ConnectionUnavailableError,
  accessTokenFor,
  disconnectConnection,
  getConnection,
  listConnections,
  markNeedsReauth,
  recordGrant,
} = await import("../../src/gmail/connections");
const { decryptToken } = await import("../../src/gmail/crypto");

const key = randomBytes(32);
let h: TestDb;

beforeAll(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h.close();
});

let seq = 0;

function grant(overrides: { sub?: string; email?: string; refreshToken?: string } = {}) {
  seq += 1;
  return {
    googleSubject: overrides.sub ?? `20000000000000${seq}`,
    email: overrides.email ?? `mailbox${seq}@co.com`,
    grantedScopes: "openid email https://www.googleapis.com/auth/gmail.readonly",
    refreshToken: overrides.refreshToken ?? `1//refresh-${seq}`,
  };
}

async function workspace(): Promise<WorkspaceScope> {
  const { user, workspace } = await seedWorkspace(h.db);
  return openWorkspace(h.db, user.id, workspace.id);
}

/** A second workspace owned by the same user: the case §4 is most careful about. */
async function secondWorkspaceOf(scope: WorkspaceScope): Promise<WorkspaceScope> {
  const [second] = await h.db
    .insert(workspaces)
    .values({ ownerId: scope.userId, name: "Second business" })
    .returning();
  return openWorkspace(h.db, scope.userId, second.id);
}

async function stored(id: string) {
  const [row] = await h.db.select().from(gmailConnections).where(eq(gmailConnections.id, id));
  return row;
}

const grantHeldElsewhere = (sub: string, except: string) =>
  isGoogleGrantHeldElsewhere(h.db, sub, except);

describe("connecting an account", () => {
  it("records it as connected, with what was granted", async () => {
    const scope = await workspace();
    const g = grant();

    const { connection, restored } = await recordGrant(scope, g, { key });

    expect(restored).toBe(false);
    expect(connection).toMatchObject({
      email: g.email,
      state: "CONNECTED",
      grantedScopes: g.grantedScopes,
      disconnectedAt: null,
    });
    expect(connection.connectedAt).toBeInstanceOf(Date);
    expect((await stored(connection.id)).googleSubject).toBe(g.googleSubject);
  });

  it("stores the refresh token encrypted, and only encrypted", async () => {
    const scope = await workspace();
    const g = grant();

    const { connection } = await recordGrant(scope, g, { key });
    const row = await stored(connection.id);

    expect(row.encryptedRefreshToken).not.toBeNull();
    expect(row.encryptedRefreshToken).not.toContain(g.refreshToken);
    expect(JSON.stringify(row)).not.toContain(g.refreshToken);
    expect(
      decryptToken(
        row.encryptedRefreshToken!,
        { workspaceId: scope.workspaceId, googleSubject: g.googleSubject },
        key,
      ),
    ).toBe(g.refreshToken);
  });

  it("restores the existing connection on reconnect rather than adding one", async () => {
    const scope = await workspace();
    const first = grant();
    const { connection } = await recordGrant(scope, first, { key });

    const again = await recordGrant(
      scope,
      { ...first, refreshToken: "1//newer", email: "renamed@co.com" },
      { key },
    );

    expect(again.restored).toBe(true);
    expect(again.connection.id).toBe(connection.id);
    expect(again.connection.email).toBe("renamed@co.com");
    expect(await scope.select(gmailConnections)).toHaveLength(1);
    const row = await stored(connection.id);
    expect(
      decryptToken(
        row.encryptedRefreshToken!,
        { workspaceId: scope.workspaceId, googleSubject: first.googleSubject },
        key,
      ),
    ).toBe("1//newer");
  });

  it("keeps several accounts in one workspace, each on its own", async () => {
    const scope = await workspace();
    const a = await recordGrant(scope, grant(), { key });
    const b = await recordGrant(scope, grant(), { key });

    await markNeedsReauth(scope, a.connection.id);

    expect((await getConnection(scope, a.connection.id)).state).toBe("NEEDS_REAUTH");
    expect((await getConnection(scope, b.connection.id)).state).toBe("CONNECTED");
    expect(await listConnections(scope)).toHaveLength(2);
  });

  it("keeps the same account in two workspaces as two connections", async () => {
    const first = await workspace();
    const second = await secondWorkspaceOf(first);
    const g = grant();

    const a = await recordGrant(first, g, { key });
    const b = await recordGrant(second, g, { key });

    expect(a.connection.id).not.toBe(b.connection.id);
    expect((await stored(a.connection.id)).encryptedRefreshToken).not.toBe(
      (await stored(b.connection.id)).encryptedRefreshToken,
    );
    expect(await listConnections(first)).toHaveLength(1);
    expect(await listConnections(second)).toHaveLength(1);
  });
});

describe("a listed connection", () => {
  it("carries no credential in any form", async () => {
    const scope = await workspace();
    const g = grant();
    await recordGrant(scope, g, { key });

    const [summary] = await listConnections(scope);

    for (const field of Object.keys(summary)) expect(field).not.toMatch(/token|secret|encrypt/i);
    expect(JSON.stringify(summary)).not.toContain(g.refreshToken);
    expect(JSON.stringify(summary)).not.toContain("v1:");
  });
});

describe("an access token", () => {
  it("is minted from the stored refresh token", async () => {
    const scope = await workspace();
    const g = grant();
    const { connection } = await recordGrant(scope, g, { key });
    const google = new FakeGoogle().respond(json(200, { access_token: "ya29.fresh" }));

    await expect(accessTokenFor(scope, connection.id, google.client, key)).resolves.toBe(
      "ya29.fresh",
    );
    expect(google.calls[0].form.get("refresh_token")).toBe(g.refreshToken);
  });

  it("moves the connection to NEEDS_REAUTH when google says the grant is invalid", async () => {
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    const google = new FakeGoogle().respond(json(400, { error: "invalid_grant" }));

    await expect(accessTokenFor(scope, connection.id, google.client, key)).rejects.toBeInstanceOf(
      ConnectionUnavailableError,
    );
    expect((await getConnection(scope, connection.id)).state).toBe("NEEDS_REAUTH");
  });

  it.each([
    ["rate limited", json(429, {})],
    ["unavailable", json(503, {})],
    ["unreachable", new TypeError("fetch failed")],
  ])("leaves the connection alone when google is %s", async (_, response) => {
    // spec: connect-gmail §8 -- transient failures never mark a connection broken.
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    const google = new FakeGoogle().respond(response);

    await expect(accessTokenFor(scope, connection.id, google.client, key)).rejects.toMatchObject({
      kind: "transient",
    });
    expect((await getConnection(scope, connection.id)).state).toBe("CONNECTED");
  });

  it("is refused without asking google once reauthorization is needed", async () => {
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    await markNeedsReauth(scope, connection.id);
    const google = new FakeGoogle();

    await expect(accessTokenFor(scope, connection.id, google.client, key)).rejects.toMatchObject({
      state: "NEEDS_REAUTH",
    });
    expect(google.calls).toEqual([]);
  });
});

describe("reauthorizing", () => {
  it("returns the same connection to CONNECTED", async () => {
    const scope = await workspace();
    const g = grant();
    const { connection } = await recordGrant(scope, g, { key });
    await markNeedsReauth(scope, connection.id);

    const again = await recordGrant(scope, { ...g, refreshToken: "1//after" }, { key });

    expect(again.connection.id).toBe(connection.id);
    expect(again.connection.state).toBe("CONNECTED");
  });
});

describe("disconnecting", () => {
  it("deletes the credentials and keeps the record", async () => {
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));

    const result = await disconnectConnection(scope, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    const row = await stored(connection.id);
    expect(row.state).toBe("DISCONNECTED");
    expect(row.encryptedRefreshToken).toBeNull();
    expect(row.disconnectedAt).toBeInstanceOf(Date);
    expect(result.connection.state).toBe("DISCONNECTED");
  });

  it("revokes the grant with google when nothing else holds it", async () => {
    const scope = await workspace();
    const g = grant();
    const { connection } = await recordGrant(scope, g, { key });
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));

    const { revocation } = await disconnectConnection(scope, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    expect(revocation).toBe("revoked");
    expect(google.revokes()).toHaveLength(1);
    expect(google.revokes()[0].form.get("token")).toBe(g.refreshToken);
  });

  it("leaves the grant alone while another workspace still holds the account", async () => {
    // Google revokes grants, not tokens: revoking here would break the other connection.
    const first = await workspace();
    const second = await secondWorkspaceOf(first);
    const g = grant();
    const { connection } = await recordGrant(first, g, { key });
    const other = await recordGrant(second, g, { key });
    const google = new FakeGoogle();

    const { revocation } = await disconnectConnection(first, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    expect(revocation).toBe("shared");
    expect(google.revokes()).toEqual([]);
    expect((await getConnection(second, other.connection.id)).state).toBe("CONNECTED");
    expect((await stored(connection.id)).encryptedRefreshToken).toBeNull();
  });

  it("revokes once the last connection holding the account goes", async () => {
    const first = await workspace();
    const second = await secondWorkspaceOf(first);
    const g = grant();
    const a = await recordGrant(first, g, { key });
    const b = await recordGrant(second, g, { key });
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));

    await disconnectConnection(first, a.connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });
    const { revocation } = await disconnectConnection(second, b.connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    expect(revocation).toBe("revoked");
    expect(google.revokes()).toHaveLength(1);
  });

  it("still deletes the credentials when google cannot be reached", async () => {
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    const google = new FakeGoogle().respond(new TypeError("fetch failed"));

    const { revocation } = await disconnectConnection(scope, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    expect(revocation).toBe("unconfirmed");
    expect((await stored(connection.id)).encryptedRefreshToken).toBeNull();
  });

  it("disconnects an account that needs reauthorization", async () => {
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    await markNeedsReauth(scope, connection.id);
    const google = new FakeGoogle().respond(json(400, { error: "invalid_token" }));

    await disconnectConnection(scope, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    expect((await stored(connection.id)).state).toBe("DISCONNECTED");
  });

  it("refuses to disconnect twice", async () => {
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));
    const deps = { client: google.client, grantHeldElsewhere, key };
    await disconnectConnection(scope, connection.id, deps);

    await expect(disconnectConnection(scope, connection.id, deps)).rejects.toThrow(
      /cannot take DISCONNECTED/,
    );
  });

  it("keeps the documents already retrieved through it", async () => {
    // spec: connect-gmail §10 -- a retrieved invoice is part of the financial record.
    const scope = await workspace();
    const { connection } = await recordGrant(scope, grant(), { key });
    const [document] = await scope.insert(supportingDocuments, {
      storageRef: `workspaces/${scope.workspaceId}/documents/x/invoice.pdf`,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      source: "GMAIL",
      sourceMetadata: { connectionId: connection.id, messageId: "m1", attachmentId: "a1" },
    });
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));

    await disconnectConnection(scope, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    const [after] = await scope.select(
      supportingDocuments,
      eq(supportingDocuments.id, document.id),
    );
    expect(after).toEqual(document);
  });

  it("can be undone by connecting the same account again, on the same record", async () => {
    const scope = await workspace();
    const g = grant();
    const { connection } = await recordGrant(scope, g, { key });
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));
    await disconnectConnection(scope, connection.id, {
      client: google.client,
      grantHeldElsewhere,
      key,
    });

    const again = await recordGrant(scope, { ...g, refreshToken: "1//back" }, { key });

    expect(again).toMatchObject({ restored: true, connection: { id: connection.id } });
    expect(again.connection.state).toBe("CONNECTED");
    expect(again.connection.disconnectedAt).toBeNull();
    expect(await scope.select(gmailConnections)).toHaveLength(1);
  });
});
