/**
 * What sign-in asks Google for.
 *
 * spec: docs/decisions/0006-authentication.md · docs/phases/phase-1.md §7A
 *
 * ADR 0006: "Sign-up requests profile scopes only. **The Gmail scope is never requested
 * at sign-up.**" `gmail.readonly` is a Restricted scope that triggers a CASA assessment,
 * and asking for it here would degrade consent for every user including those who never
 * connect a mailbox.
 *
 * Feature J adds the Gmail scope at mailbox-connect time. That is a different
 * authorization request, and this test is what keeps the two from merging by accident.
 */

import { describe, expect, it } from "vitest";

import { SIGN_IN_SCOPES, googleProvider } from "../../src/auth/google";

type Authorization = { params?: { scope?: unknown } } | string | undefined;

/**
 * The scope string the provider will actually put on the authorization request.
 *
 * The provider factory stashes what we passed under `options` and Auth.js merges it into
 * the top level later, so both places are checked — a pinned beta is free to change which
 * one wins, and this guard must not quietly stop looking.
 *
 * Throwing rather than returning a default matters: a test that silently found no scope
 * would pass every assertion below while proving nothing.
 */
function configuredScope(): string {
  const provider = googleProvider as unknown as {
    authorization?: Authorization;
    options?: { authorization?: Authorization };
  };

  for (const authorization of [provider.authorization, provider.options?.authorization]) {
    if (typeof authorization === "string") return authorization;
    const scope = authorization?.params?.scope;
    if (typeof scope === "string") return scope;
  }

  throw new Error("the google provider declares no scope; this test cannot verify it");
}

describe("the sign-in authorization request", () => {
  it("asks for profile and email only", () => {
    expect(configuredScope().split(" ").sort()).toEqual(["email", "openid", "profile"]);
  });

  it("requests no gmail scope", () => {
    expect(configuredScope()).not.toContain("gmail");
  });

  it("requests no google api scope at all", () => {
    // Every Restricted and Sensitive Google scope is a googleapis.com URL. Profile and
    // email are bare OIDC scopes, so any URL here is a scope Feature A must not ask for.
    expect(configuredScope()).not.toContain("googleapis.com");
  });

  it("declares the same scopes the provider is built from", () => {
    expect(configuredScope()).toBe(SIGN_IN_SCOPES.join(" "));
  });
});
