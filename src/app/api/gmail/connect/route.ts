/**
 * Leaving for Google's consent screen to connect a mailbox.
 *
 * spec: docs/workflows/connect-gmail.md §3, §5
 *
 * The workspace comes from `requireScope`, which checks the session owns it, and the id
 * the page passes only chooses which of the user's workspaces is meant — the page names
 * that workspace in its pre-consent copy, so the connection lands where the user was told
 * it would. Everything else is `src/gmail/connect-flow.ts`.
 *
 * A GET because it is followed from a link, and safe as one: it changes nothing but a
 * short-lived cookie, and the attempt it starts can only be finished by the same signed-in
 * user coming back from Google with the matching state.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireScope } from "../../../../auth/workspace";
import { ConnectionNotFoundError, getConnection } from "../../../../gmail/connections";
import { PENDING_COOKIE, PENDING_COOKIE_PATH, startConnect } from "../../../../gmail/connect-flow";
import {
  GoogleOAuthError,
  googleOAuthClient,
  type GoogleOAuthClient,
} from "../../../../gmail/oauth";

/** Long enough to read a consent screen; the attempt itself expires on the same clock. */
const PENDING_MAX_AGE_SECONDS = 10 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scope = await requireScope(url.searchParams.get("workspace") ?? undefined);

  let client: GoogleOAuthClient;
  try {
    client = googleOAuthClient();
  } catch (error) {
    if (error instanceof GoogleOAuthError) redirect("/connections?error=config");
    throw error;
  }

  /*
   * Reconnecting a known account: offer it first on Google's account chooser. Only a
   * connection in this workspace can be named, and a stale id simply connects afresh --
   * whichever account the user then picks is what gets recorded.
   */
  let loginHint: string | undefined;
  const reconnect = url.searchParams.get("reconnect");
  if (reconnect && UUID.test(reconnect)) {
    try {
      loginHint = (await getConnection(scope, reconnect)).email;
    } catch (error) {
      if (!(error instanceof ConnectionNotFoundError)) throw error;
    }
  }

  const { authorizationUrl, pendingCookie } = startConnect(scope, {
    client,
    origin: url.origin,
    loginHint,
  });

  (await cookies()).set(PENDING_COOKIE, pendingCookie, {
    httpOnly: true,
    // Lax, not Strict: the return from Google is a cross-site top-level navigation, and
    // Strict would withhold the cookie from exactly that request.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: PENDING_COOKIE_PATH,
    maxAge: PENDING_MAX_AGE_SECONDS,
  });

  redirect(authorizationUrl);
}
