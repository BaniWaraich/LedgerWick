"use server";

/**
 * Disconnecting a mailbox.
 *
 * spec: docs/workflows/connect-gmail.md §10
 *
 * Thin, like the other actions: the scope comes from the session, and the work is
 * `disconnectConnection`. The id in the form is a claim; the scope decides whether it names
 * anything, and an id from another workspace is indistinguishable from one that does not
 * exist.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { googleGrantHeldElsewhere } from "../../../auth/gmail-grants";
import { requireScope } from "../../../auth/workspace";
import { InvalidConnectionTransitionError } from "../../../gmail/connection-state";
import {
  ConnectionNotFoundError,
  disconnectConnection,
  type Revocation,
} from "../../../gmail/connections";
import { googleOAuthClient } from "../../../gmail/oauth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function disconnectAction(formData: FormData): Promise<void> {
  const scope = await requireScope();
  const id = String(formData.get("connectionId") ?? "");
  if (!UUID.test(id)) redirect("/connections?error=not_found");

  let revocation: Revocation;
  try {
    ({ revocation } = await disconnectConnection(scope, id, {
      client: googleOAuthClient(),
      grantHeldElsewhere: googleGrantHeldElsewhere,
    }));
  } catch (error) {
    if (error instanceof ConnectionNotFoundError) redirect("/connections?error=not_found");
    // Already disconnected -- by another tab, most likely. Nothing to do but show it.
    if (error instanceof InvalidConnectionTransitionError) redirect("/connections");
    throw error;
  }

  revalidatePath("/connections");
  revalidatePath("/reconciliation");
  redirect(`/connections?disconnected=${revocation}`);
}
