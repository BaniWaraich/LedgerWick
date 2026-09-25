/**
 * Whether a Google grant is still in use by another Gmail Connection.
 *
 * spec: docs/workflows/connect-gmail.md §10 · docs/decisions/0006-authentication.md
 * (amended)
 *
 * The one question feature J has to ask across workspaces. Google revokes a grant, not a
 * token, so disconnecting one connection must not revoke an account that another
 * connection -- in this workspace, another of the user's, or someone else's entirely --
 * still relies on.
 *
 * Unscoped by necessity, like `listWorkspaces`, and narrow for the same reason: it answers
 * yes or no and returns no row, no id and no workspace. Nothing about the other connection
 * leaves this function except that it exists.
 */

import { and, eq, ne } from "drizzle-orm";

import type { Database } from "./client";
import { gmailConnections } from "./schema";

export async function isGoogleGrantHeldElsewhere(
  db: Database,
  googleSubject: string,
  exceptConnectionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: gmailConnections.id })
    .from(gmailConnections)
    .where(
      and(
        eq(gmailConnections.googleSubject, googleSubject),
        ne(gmailConnections.id, exceptConnectionId),
        // Holding credentials is what makes a connection depend on the grant; the table's
        // check makes that the same as not being DISCONNECTED.
        ne(gmailConnections.state, "DISCONNECTED"),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
