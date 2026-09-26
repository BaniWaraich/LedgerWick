/**
 * The mailbox authorization request, and what comes back from it.
 *
 * spec: docs/workflows/connect-gmail.md §5, §6, §8
 */

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { CLIENT_ID, FakeGoogle, grantResponse, json } from "./fake-google";

vi.mock("server-only", () => ({}));

const {
  CONNECT_SCOPES,
  GMAIL_READONLY_SCOPE,
  GoogleOAuthError,
  beginConnect,
  checkCallback,
  decodePending,
  encodePending,
  exchangeCode,
  googleOAuthClient,
  refreshAccessToken,
  revokeToken,
} = await import("../../src/gmail/oauth");

const redirectUri = "http://localhost:3000/api/gmail/callback";

function begin(extra: { loginHint?: string } = {}) {
  return beginConnect({
    clientId: CLIENT_ID,
    redirectUri,
    workspaceId: "11111111-1111-1111-1111-111111111111",
    userId: "user_1",
    ...extra,
  });
}

describe("the connect request", () => {
  it("asks for read-only mail and the identity of the account, nothing else", () => {
    const url = new URL(begin().authorizationUrl);

    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(
      ["email", "openid", "https://www.googleapis.com/auth/gmail.readonly"].sort(),
    );
    expect(CONNECT_SCOPES).toContain(GMAIL_READONLY_SCOPE);
  });

  it("asks for no broader gmail scope", () => {
    const scope = new URL(begin().authorizationUrl).searchParams.get("scope")!;

    for (const s of scope.split(" ").filter((s) => s.includes("gmail"))) {
      expect(s).toBe(GMAIL_READONLY_SCOPE);
    }
  });

  it("does not fold in scopes granted before", () => {
    // Without this the mailbox token could inherit whatever else the account once
    // granted this client -- sign-in included.
    expect(new URL(begin().authorizationUrl).searchParams.has("include_granted_scopes")).toBe(
      false,
    );
  });

  it("asks for a refresh token every time, including on a reconnect", () => {
    const params = new URL(begin().authorizationUrl).searchParams;

    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });

  it("goes to google's consent screen and comes back to the gmail callback", () => {
    const url = new URL(begin().authorizationUrl);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("binds the attempt with state and a PKCE challenge", () => {
    const { authorizationUrl, pending } = begin();
    const params = new URL(authorizationUrl).searchParams;

    expect(params.get("state")).toBe(pending.state);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(
      createHash("sha256").update(pending.codeVerifier).digest("base64url"),
    );
  });

  it("never puts the verifier in the url", () => {
    const { authorizationUrl, pending } = begin();

    expect(authorizationUrl).not.toContain(pending.codeVerifier);
  });

  it("offers the known account when reconnecting", () => {
    const params = new URL(begin({ loginHint: "finance@co.com" }).authorizationUrl).searchParams;

    expect(params.get("login_hint")).toBe("finance@co.com");
  });

  it("is different on every attempt", () => {
    expect(begin().pending.state).not.toBe(begin().pending.state);
  });
});

describe("the pending attempt", () => {
  it("survives its cookie", () => {
    const { pending } = begin();

    expect(decodePending(encodePending(pending))).toEqual(pending);
  });

  it.each([undefined, "", "not-base64-json", Buffer.from("{}").toString("base64url")])(
    "is nothing when the cookie is %s",
    (value) => {
      expect(decodePending(value)).toBeNull();
    },
  );
});

describe("the callback", () => {
  const { pending } = begin();
  const params = (values: Record<string, string>) => new URLSearchParams(values);

  it("accepts the attempt this user started", () => {
    const result = checkCallback({
      params: params({ state: pending.state, code: "4/code" }),
      pending,
      sessionUserId: "user_1",
    });

    expect(result).toEqual({ ok: true, code: "4/code", pending });
  });

  it("refuses a callback with no attempt in progress", () => {
    const result = checkCallback({
      params: params({ state: pending.state, code: "4/code" }),
      pending: null,
      sessionUserId: "user_1",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses a state that is not this attempt's", () => {
    const result = checkCallback({
      params: params({ state: "forged", code: "4/code" }),
      pending,
      sessionUserId: "user_1",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses an attempt started by someone other than who is signed in", () => {
    const result = checkCallback({
      params: params({ state: pending.state, code: "4/code" }),
      pending,
      sessionUserId: "user_2",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_state" });
  });

  it("refuses an attempt left too long", () => {
    const result = checkCallback({
      params: params({ state: pending.state, code: "4/code" }),
      pending,
      sessionUserId: "user_1",
      now: pending.createdAt + 11 * 60 * 1000,
    });

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("reports that the user declined", () => {
    const result = checkCallback({
      params: params({ state: pending.state, error: "access_denied" }),
      pending,
      sessionUserId: "user_1",
    });

    expect(result).toEqual({ ok: false, reason: "denied" });
  });
});

describe("exchanging the code", () => {
  const input = { code: "4/code", codeVerifier: "verifier", redirectUri };

  it("yields the account and its refresh token", async () => {
    const google = new FakeGoogle().respond(
      grantResponse({ sub: "1001", email: "finance@co.com", refreshToken: "1//refresh" }),
    );

    const grant = await exchangeCode(google.client, input);

    expect(grant).toMatchObject({
      googleSubject: "1001",
      email: "finance@co.com",
      refreshToken: "1//refresh",
    });
    expect(grant.grantedScopes).toContain(GMAIL_READONLY_SCOPE);
  });

  it("sends the verifier with the code", async () => {
    const google = new FakeGoogle().respond(
      grantResponse({ sub: "1001", email: "a@co.com", refreshToken: "r" }),
    );

    await exchangeCode(google.client, input);

    expect(google.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(google.calls[0].form.get("code_verifier")).toBe("verifier");
    expect(google.calls[0].form.get("grant_type")).toBe("authorization_code");
  });

  it("refuses a grant without read access to mail", async () => {
    // Google's granular consent lets the user untick the mail permission.
    const google = new FakeGoogle().respond(
      grantResponse({ sub: "1001", email: "a@co.com", refreshToken: "r", scope: "openid email" }),
    );

    await expect(exchangeCode(google.client, input)).rejects.toMatchObject({
      kind: "scope_not_granted",
    });
  });

  it("refuses a grant with nothing lasting to store", async () => {
    const google = new FakeGoogle().respond(
      grantResponse({ sub: "1001", email: "a@co.com", refreshToken: "" }),
    );

    await expect(exchangeCode(google.client, input)).rejects.toMatchObject({
      kind: "no_refresh_token",
    });
  });

  it.each([
    ["issued for another client", { aud: "someone-else" }],
    ["issued by someone other than google", { iss: "https://evil.example" }],
    ["expired", { exp: 1 }],
    ["for an unverified address", { email_verified: false }],
    ["with no subject", { sub: "" }],
  ])("refuses an identity %s", async (_, claims) => {
    const google = new FakeGoogle().respond(
      grantResponse({ sub: "1001", email: "a@co.com", refreshToken: "r", claims }),
    );

    await expect(exchangeCode(google.client, input)).rejects.toMatchObject({
      kind: "invalid_identity",
    });
  });
});

describe("a failure from google", () => {
  const refresh = (response: Response | Error) =>
    refreshAccessToken(new FakeGoogle().respond(response).client, "1//secret-refresh-token");

  it("is invalid_grant when google says the grant is dead", async () => {
    await expect(refresh(json(400, { error: "invalid_grant" }))).rejects.toMatchObject({
      kind: "invalid_grant",
    });
  });

  it.each([
    ["rate limited", json(429, { error: "rate_limit_exceeded" })],
    ["unavailable", json(503, { error: "backend_error" })],
    ["unreachable", new TypeError("fetch failed")],
  ])("is transient when google is %s", async (_, response) => {
    await expect(refresh(response)).rejects.toMatchObject({ kind: "transient" });
  });

  it("is config when our client is wrong", async () => {
    await expect(refresh(json(401, { error: "invalid_client" }))).rejects.toMatchObject({
      kind: "config",
    });
  });

  it("carries nothing google or we sent", async () => {
    const error = await refresh(
      json(400, { error: "invalid_grant", error_description: "Token 1//secret-refresh-token" }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoogleOAuthError);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(String(error)).not.toContain("secret");
    expect((error as Error).message).toBe("Google OAuth failed: invalid_grant");
  });
});

describe("refreshing", () => {
  it("returns a fresh access token", async () => {
    const google = new FakeGoogle().respond(json(200, { access_token: "ya29.fresh" }));

    await expect(refreshAccessToken(google.client, "1//r")).resolves.toBe("ya29.fresh");
    expect(google.calls[0].form.get("grant_type")).toBe("refresh_token");
  });
});

describe("revoking", () => {
  it("is confirmed when google accepts it", async () => {
    const google = new FakeGoogle().respond(new Response(null, { status: 200 }));

    await expect(revokeToken(google.client, "1//r")).resolves.toBe(true);
    expect(google.calls[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(google.calls[0].form.get("token")).toBe("1//r");
  });

  it("is confirmed when google no longer knows the token", async () => {
    const google = new FakeGoogle().respond(json(400, { error: "invalid_token" }));

    await expect(revokeToken(google.client, "1//r")).resolves.toBe(true);
  });

  it.each([
    ["unavailable", json(503, {})],
    ["unreachable", new TypeError("fetch failed")],
  ])("is unconfirmed, not thrown, when google is %s", async (_, response) => {
    const google = new FakeGoogle().respond(response);

    await expect(revokeToken(google.client, "1//r")).resolves.toBe(false);
  });
});

describe("the oauth client", () => {
  it("is refused without credentials, naming none", () => {
    expect(() => googleOAuthClient({})).toThrow(GoogleOAuthError);
    expect(() => googleOAuthClient({ GOOGLE_CLIENT_ID: "id" })).toThrow("config");
  });
});
