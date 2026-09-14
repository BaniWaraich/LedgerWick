/**
 * Optimistic redirect for signed-out traffic.
 *
 * This is a convenience, not a security boundary. It only looks for the presence of a
 * session cookie — it does not validate it, and it deliberately touches no database: the
 * Next authentication guide is explicit that proxy runs on every request including
 * prefetches, and that "security checks should be performed as close as possible to your
 * data source".
 *
 * The real check is `requireUser` and `requireScope` in `src/auth`, which run per render
 * against the session and `openWorkspace`. Deleting this file would cost a redirect, not
 * an authorization guarantee.
 *
 * `middleware.ts` is deprecated in Next 16 and renamed to `proxy.ts`
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
 */

import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth.js names its session cookie `authjs.session-token`, prefixed with `__Secure-` when
 * it is issued over HTTPS. Both are checked so this behaves the same locally and in
 * production.
 */
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

export function proxy(request: NextRequest) {
  const signedIn = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (signedIn) return NextResponse.next();

  const login = new URL("/login", request.url);
  return NextResponse.redirect(login);
}

export const config = {
  // Only the authenticated areas. The landing page, /login and the Auth.js routes must
  // stay reachable signed out, and matching them here would be a redirect loop.
  matcher: ["/home/:path*", "/workspaces/:path*"],
};
