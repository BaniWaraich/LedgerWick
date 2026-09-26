/**
 * Google's token and revoke endpoints, scripted.
 *
 * `testing-strategy.md`: test the code around a third-party API, not the API. This stands
 * in for the network behind a `GoogleOAuthClient`, answers each call from a queue the test
 * sets up, and records what was asked so a test can assert that a revoke did or did not
 * happen.
 */

import type { GoogleOAuthClient } from "../../src/gmail/oauth";

export const CLIENT_ID = "test-client.apps.googleusercontent.com";

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

/** An ID token as Google's token endpoint returns it. Unsigned: see `identityFrom`. */
export function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

/** What the token endpoint says when a user completes consent for this account. */
export function grantResponse(account: {
  sub: string;
  email: string;
  refreshToken: string;
  scope?: string;
  claims?: Record<string, unknown>;
}) {
  return json(200, {
    access_token: `access-for-${account.sub}`,
    expires_in: 3599,
    refresh_token: account.refreshToken,
    scope:
      account.scope ?? `openid ${GMAIL_READONLY} https://www.googleapis.com/auth/userinfo.email`,
    token_type: "Bearer",
    id_token: idToken({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: account.sub,
      email: account.email,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...account.claims,
    }),
  });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export type Call = { url: string; form: URLSearchParams };

export class FakeGoogle {
  readonly calls: Call[] = [];
  private readonly queue: (Response | Error)[] = [];

  /** Answer the next call with this, in order. */
  respond(...responses: (Response | Error)[]): this {
    this.queue.push(...responses);
    return this;
  }

  get client(): GoogleOAuthClient {
    return {
      clientId: CLIENT_ID,
      clientSecret: "test-client-secret",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        this.calls.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? "")) });
        const next = this.queue.shift();
        if (!next) throw new Error(`FakeGoogle: no response scripted for ${String(url)}`);
        if (next instanceof Error) throw next;
        return next;
      }) as typeof fetch,
    };
  }

  revokes(): Call[] {
    return this.calls.filter((c) => c.url.endsWith("/revoke"));
  }
}
