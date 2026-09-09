/**
 * The authenticated user, on the server.
 *
 * This is the only place `userId` enters the application. It comes from the Auth.js
 * session and never from a request parameter, a header, or a cookie the client can write
 * (docs/decisions/0006-authentication.md: "Every authenticated route derives `userId`
 * from the session on the server").
 *
 * `server-only` makes importing this from a client component a build error rather than a
 * leak discovered later.
 */

import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "./config";

export type AuthenticatedUser = {
  userId: string;
  email: string | null;
};

/**
 * The signed-in user, or a redirect to sign-in.
 *
 * Memoized per render pass, so a layout and the page inside it resolve one session rather
 * than two. `redirect` throws, so there is no branch in which this returns without a user.
 */
export const requireUser = cache(async (): Promise<AuthenticatedUser> => {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) redirect("/login");

  return { userId, email: session.user?.email ?? null };
});

/** The session, without forcing a redirect. For deciding what to render, not for access. */
export const currentUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const session = await auth();
  const userId = session?.user?.id;

  return userId ? { userId, email: session.user?.email ?? null } : null;
});
