/**
 * Google's OAuth endpoints, for connecting a mailbox.
 *
 * spec: docs/workflows/connect-gmail.md §5, §6, §8 · docs/decisions/0006-authentication.md
 * (amended)
 *
 * This is the only file that talks to Google, and in feature J it talks to exactly three
 * places: the consent screen, the token endpoint and the revoke endpoint. It sends no
 * request to the Gmail API; searching mail is feature K's.
 *
 * Sign-in does not come through here. It is Auth.js, asking for profile and email only
 * (`src/auth/google.ts`). This is a second, separate authorization request against the same
 * OAuth client, made only when a user chooses to connect a mailbox, which is what
 * "incremental" means in `connect-gmail.md §5`.
 *
 * Two rules shape every function below:
 *
 * - **A failure never carries a token.** Google's error responses are reduced to a
 *   `GoogleOAuthError` with a kind and nothing else before they leave this file. The raw
 *   body is never thrown, logged or returned (`connect-gmail.md §6`: "never included in
 *   error reports").
 * - **Only `invalid_grant` means the user must act.** Rate limiting, 5xx and network
 *   failure are `transient`, and nothing downstream may mark a connection broken over one
 *   (`connect-gmail.md §8`).
 */

import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * What connecting a mailbox asks Google for.
 *
 * `gmail.readonly` and nothing broader (§5). `openid` and `email` are identity, not mail:
 * they say *which* Google account was granted, so the connection is recorded against its
 * stable `sub` rather than an address that can change.
 */
export const CONNECT_SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE] as const;

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Where Google sends the user back. Registered on the OAuth client for every origin. */
export function callbackUri(origin: string): string {
  return `${origin}/api/gmail/callback`;
}

/** How long a user may sit on Google's consent screen before the attempt is abandoned. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * The OAuth client and the network.
 *
 * `fetch` is injected so every test runs without a network and can script what Google
 * says; `testing-strategy.md` tests the code around a third-party API, not the API.
 */
export type GoogleOAuthClient = {
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
};

/**
 * Why an OAuth exchange did not produce what was needed.
 *
 * - `invalid_grant`: Google says the grant or code is no longer valid. The user must act.
 * - `transient`: rate limited, Google unavailable, or the network failed. Retry later.
 * - `config`: our OAuth client is misconfigured. An operator must act.
 * - `scope_not_granted`: the user unticked the mail permission on the consent screen.
 * - `no_refresh_token`: Google granted access but returned nothing lasting to store.
 * - `invalid_identity`: the ID token did not identify a verified Google account for us.
 */
export type GoogleOAuthErrorKind =
  | "invalid_grant"
  | "transient"
  | "config"
  | "scope_not_granted"
  | "no_refresh_token"
  | "invalid_identity";

export class GoogleOAuthError extends Error {
  constructor(readonly kind: GoogleOAuthErrorKind) {
    // The kind is the whole message. Nothing Google sent back is repeated here.
    super(`Google OAuth failed: ${kind}`);
    this.name = "GoogleOAuthError";
  }
}

/** The configured client, or a `config` error that names no secret. */
export function googleOAuthClient(
  env: Record<string, string | undefined> = process.env,
): GoogleOAuthClient {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GoogleOAuthError("config");

  return { clientId, clientSecret, fetch: globalThis.fetch };
}

/* --------------------------------------------------------------- the request */

/**
 * One connect attempt in flight, held in an httpOnly cookie between leaving for Google
 * and coming back.
 *
 * `workspaceId` and `userId` record what the attempt was *for*. They are claims, not
 * proof: the callback re-derives the user from the session and re-opens the workspace
 * through `openWorkspace`, and refuses when either disagrees.
 */
export type PendingConnect = {
  state: string;
  codeVerifier: string;
  workspaceId: string;
  userId: string;
  createdAt: number;
};

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The URL that sends the user to Google's consent screen, and what to remember meanwhile.
 *
 * - `access_type=offline` and `prompt=consent`: a refresh token, every time. Without the
 *   prompt, Google returns one only on the first grant, and a reconnect would come back
 *   with nothing to store.
 * - PKCE (S256): an intercepted code is useless without the verifier in our cookie.
 * - **No `include_granted_scopes`.** The mailbox token must carry exactly what was asked
 *   for here, never whatever else the account once granted this client.
 * - `login_hint`, when reconnecting a known account, so Google offers that one first.
 */
export function beginConnect(input: {
  clientId: string;
  redirectUri: string;
  workspaceId: string;
  userId: string;
  loginHint?: string;
  now?: number;
}): { authorizationUrl: string; pending: PendingConnect } {
  const pending: PendingConnect = {
    state: randomToken(),
    codeVerifier: randomToken(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    createdAt: input.now ?? Date.now(),
  };

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CONNECT_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", pending.state);
  url.searchParams.set(
    "code_challenge",
    createHash("sha256").update(pending.codeVerifier).digest("base64url"),
  );
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);

  return { authorizationUrl: url.toString(), pending };
}

export function encodePending(pending: PendingConnect): string {
  return Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
}

/** The pending attempt from its cookie, or null for anything that is not one. */
export function decodePending(value: string | undefined): PendingConnect | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    const strings = ["state", "codeVerifier", "workspaceId", "userId"] as const;
    if (strings.some((k) => typeof p[k] !== "string" || p[k] === "")) return null;
    if (typeof p.createdAt !== "number") return null;
    return parsed as PendingConnect;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- the callback */

export type CallbackCheck =
  | { ok: true; code: string; pending: PendingConnect }
  | { ok: false; reason: "denied" | "invalid_state" | "expired" };

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether the request Google sent back belongs to an attempt this user started.
 *
 * Refused, in order: no attempt in progress, a `state` that is not this attempt's, an
 * attempt started by a different user than the one now signed in, an attempt older than
 * its time limit, and the user declining on Google's screen. Nothing is exchanged and
 * nothing is written for any of them.
 */
export function checkCallback(input: {
  params: URLSearchParams;
  pending: PendingConnect | null;
  sessionUserId: string;
  now?: number;
}): CallbackCheck {
  const { params, pending } = input;
  const state = params.get("state");

  if (!pending || !state || !sameString(state, pending.state)) {
    return { ok: false, reason: "invalid_state" };
  }
  if (pending.userId !== input.sessionUserId) return { ok: false, reason: "invalid_state" };
  if ((input.now ?? Date.now()) - pending.createdAt > PENDING_TTL_MS) {
    return { ok: false, reason: "expired" };
  }

  const code = params.get("code");
  if (params.get("error") || !code) return { ok: false, reason: "denied" };

  return { ok: true, code, pending };
}

/* ------------------------------------------------------------- the endpoints */

/** What a completed consent leaves us with. `refreshToken` is plaintext: encrypt it next. */
export type Grant = {
  googleSubject: string;
  email: string;
  grantedScopes: string;
  refreshToken: string;
};

/**
 * Call a token endpoint, and reduce any failure to a kind.
 *
 * `invalid_grant` is Google's word for "this code or refresh token is dead", and the one
 * response that means the user must reconnect. Every other 4xx is our client being wrong
 * (`invalid_client`, `redirect_uri_mismatch`). 429 and 5xx are Google being briefly
 * unavailable, and a thrown fetch is the network.
 */
async function postForm(
  client: GoogleOAuthClient,
  url: string,
  form: Record<string, string>,
): Promise<Response> {
  try {
    return await client.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new GoogleOAuthError("transient");
  }
}

async function tokenResponse(response: Response): Promise<Record<string, unknown>> {
  if (response.ok) {
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new GoogleOAuthError("transient");
    }
  }

  if (response.status === 429 || response.status >= 500) throw new GoogleOAuthError("transient");

  let error: unknown;
  try {
    error = ((await response.json()) as { error?: unknown }).error;
  } catch {
    error = undefined;
  }
  throw new GoogleOAuthError(error === "invalid_grant" ? "invalid_grant" : "config");
}

/**
 * The identity in an ID token, checked.
 *
 * Not verified by signature, deliberately: this token arrives in the body of our own TLS
 * request to Google's token endpoint, authenticated by our client secret, and OpenID
 * Connect Core §3.1.3.7 (6) allows TLS server validation in place of the signature for
 * exactly that case. What is checked is what TLS cannot vouch for: that it was issued for
 * this client, by Google, is unexpired, and names a verified address.
 */
function identityFrom(idToken: unknown, clientId: string, now: number) {
  if (typeof idToken !== "string") throw new GoogleOAuthError("invalid_identity");

  let claims: Record<string, unknown>;
  try {
    const payload = idToken.split(".")[1] ?? "";
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new GoogleOAuthError("invalid_identity");
  }

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const valid =
    typeof claims.iss === "string" &&
    ISSUERS.includes(claims.iss) &&
    audience.includes(clientId) &&
    typeof claims.exp === "number" &&
    claims.exp * 1000 > now &&
    typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof claims.email === "string" &&
    claims.email !== "" &&
    claims.email_verified === true;

  if (!valid) throw new GoogleOAuthError("invalid_identity");

  return { googleSubject: claims.sub as string, email: claims.email as string };
}

/**
 * Trade the code from the consent screen for a grant.
 *
 * A grant without `gmail.readonly` is refused here, before anything is stored: Google's
 * granular consent lets the user untick it, and an account we cannot read is not a
 * connection (`connect-gmail.md §5`).
 */
export async function exchangeCode(
  client: GoogleOAuthClient,
  input: { code: string; codeVerifier: string; redirectUri: string; now?: number },
): Promise<Grant> {
  const body = await tokenResponse(
    await postForm(client, TOKEN_URL, {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  );

  const grantedScopes = typeof body.scope === "string" ? body.scope : "";
  if (!grantedScopes.split(" ").includes(GMAIL_READONLY_SCOPE)) {
    throw new GoogleOAuthError("scope_not_granted");
  }

  if (typeof body.refresh_token !== "string" || body.refresh_token === "") {
    throw new GoogleOAuthError("no_refresh_token");
  }

  return {
    ...identityFrom(body.id_token, client.clientId, input.now ?? Date.now()),
    grantedScopes,
    refreshToken: body.refresh_token,
  };
}

/** A short-lived access token, minted from a refresh token. Never persisted. */
export async function refreshAccessToken(
  client: GoogleOAuthClient,
  refreshToken: string,
): Promise<string> {
  const body = await tokenResponse(
    await postForm(client, TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  );

  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new GoogleOAuthError("transient");
  }
  return body.access_token;
}

/**
 * Withdraw the grant with Google. True when Google no longer honours it.
 *
 * A 400 means Google does not recognise the token — already revoked, or expired — which
 * is the outcome being asked for. Anything else is reported as unconfirmed rather than
 * thrown, because disconnect deletes our copy regardless (`connect-gmail.md §10`).
 */
export async function revokeToken(client: GoogleOAuthClient, token: string): Promise<boolean> {
  try {
    const response = await postForm(client, REVOKE_URL, { token });
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}
