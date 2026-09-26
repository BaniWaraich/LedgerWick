/**
 * Coming back from Google's consent screen.
 *
 * spec: docs/workflows/connect-gmail.md §5, §9
 *
 * The attempt's cookie is cleared before anything else, so a callback can be used once:
 * a replayed URL arrives with no attempt to match and is refused. The user comes from the
 * session, the workspace is re-opened through `requireScope`, and the rest — checking the
 * attempt, exchanging the code, recording the grant — is `completeConnect`.
 *
 * What reaches the browser is a redirect to the connections page with a connection id or
 * a reason. No token, code or Google response is ever part of it.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireUser } from "../../../../auth/session";
import { activateWorkspace, requireScope } from "../../../../auth/workspace";
import {
  completeConnect,
  PENDING_COOKIE,
  PENDING_COOKIE_PATH,
} from "../../../../gmail/connect-flow";
import { inngest, retrievalRequested } from "../../../../inngest/client";
import {
  GoogleOAuthError,
  googleOAuthClient,
  type GoogleOAuthClient,
} from "../../../../gmail/oauth";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const store = await cookies();
  const pendingCookie = store.get(PENDING_COOKIE)?.value;
  store.set(PENDING_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: PENDING_COOKIE_PATH,
    maxAge: 0,
  });

  const { userId } = await requireUser();

  let client: GoogleOAuthClient;
  try {
    client = googleOAuthClient();
  } catch (error) {
    if (error instanceof GoogleOAuthError) redirect("/connections?error=config");
    throw error;
  }

  const outcome = await completeConnect({
    params: url.searchParams,
    pendingCookie,
    sessionUserId: userId,
    openScope: (workspaceId) => requireScope(workspaceId),
    client,
    origin: url.origin,
  });

  if (outcome.kind === "failed") redirect(`/connections?error=${outcome.reason}`);

  /*
   * A mailbox now exists, or works again: search for what is waiting on one
   * (`connect-gmail.md §9`). A queue that cannot be reached does not undo the connection --
   * the next reconciliation run searches anyway -- so a failure here is not the user's.
   */
  try {
    await inngest.send(retrievalRequested.create({ workspaceId: outcome.workspaceId, userId }));
  } catch {
    // Deliberately silent: see above.
  }

  // Show the workspace the mailbox was connected to, even if another tab switched away.
  await activateWorkspace(outcome.workspaceId);
  redirect(`/connections?connected=${outcome.connection.id}`);
}
