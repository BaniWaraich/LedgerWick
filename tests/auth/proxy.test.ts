/**
 * Signed-out traffic is turned away.
 *
 * spec: docs/phases/phase-1.md §7A
 *
 * This is the optimistic check, not the authorization one — it reads a cookie's presence
 * and nothing else, and `requireScope` is what actually decides. What these tests pin down
 * is the part that would silently rot: the matcher. A protected area missing from it, or a
 * public route wrongly inside it, is either an unguarded page or a redirect loop, and
 * neither shows up in a type check.
 */

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { config, proxy } from "../../src/proxy";

function request(path: string, cookie?: { name: string; value: string }) {
  const req = new NextRequest(`http://localhost:3000${path}`);
  if (cookie) req.cookies.set(cookie.name, cookie.value);
  return req;
}

/** Does the matcher cover this path? Mirrors how Next applies `config.matcher`. */
function matches(path: string): boolean {
  return config.matcher.some((pattern) => {
    const source = pattern.replace(/\/:path\*$/, "(?:/.*)?");
    return new RegExp(`^${source}$`).test(path);
  });
}

describe("a signed-out request", () => {
  it("is sent to sign in", () => {
    const response = proxy(request("/home"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });
});

describe("a request carrying a session cookie", () => {
  it("is let through", () => {
    const response = proxy(request("/home", { name: "authjs.session-token", value: "a-session" }));

    expect(response.headers.get("location")).toBeNull();
  });

  it("is let through behind https, where the cookie name is prefixed", () => {
    const response = proxy(
      request("/home", { name: "__Secure-authjs.session-token", value: "a-session" }),
    );

    expect(response.headers.get("location")).toBeNull();
  });
});

describe("the matcher", () => {
  it("covers every authenticated area", () => {
    for (const path of ["/home", "/workspaces", "/workspaces/new", "/reconciliations/abc"]) {
      expect(matches(path), `${path} is unprotected`).toBe(true);
    }
  });

  it("leaves the public routes alone", () => {
    // Matching these would redirect a signed-out visitor away from the page that signs
    // them in, or break the OAuth callback — a loop, not a lockout.
    for (const path of ["/", "/login", "/api/auth/signin", "/api/auth/callback/google"]) {
      expect(matches(path), `${path} must stay reachable signed out`).toBe(false);
    }
  });

  // Google's OAuth verification reviewers read these pages without an account, and the
  // consent screen links to them. Putting either behind the session cookie fails the
  // review rather than breaking a page, which is a slow and expensive way to find out.
  it("leaves the legal pages public, because OAuth verification depends on it", () => {
    for (const path of ["/privacy-policy", "/terms-and-conditions"]) {
      expect(matches(path), `${path} must stay reachable signed out`).toBe(false);
    }
  });
});
