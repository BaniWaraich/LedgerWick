"use server";

/**
 * Workspace actions.
 *
 * These are thin on purpose. Identity comes from the session inside the auth layer, the
 * membership check lives in `openWorkspace`, and neither is repeated here — an action
 * that re-implemented either would be a second place for the rule to drift.
 */

import { redirect } from "next/navigation";

import { activateWorkspace, createWorkspaceForUser } from "../../auth/workspace";
import { InvalidWorkspaceNameError, WorkspaceAccessError } from "../../db/workspace-scope";

export type WorkspaceFormState = { error: string | null };

/** Create a workspace and go to it. The owner is the session's user, not a form field. */
export async function createWorkspaceAction(
  _previous: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  const name = String(formData.get("name") ?? "");

  try {
    await createWorkspaceForUser(name);
  } catch (error) {
    if (error instanceof InvalidWorkspaceNameError) return { error: error.message };
    throw error;
  }

  redirect("/home");
}

/**
 * Switch to a workspace.
 *
 * The id arrives from the client, so it is checked: `activateWorkspace` opens the
 * workspace before writing the cookie. A workspace that is not the user's sends them back
 * to the picker rather than surfacing whether it exists.
 */
export async function selectWorkspaceAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");

  try {
    await activateWorkspace(workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) redirect("/workspaces");
    throw error;
  }

  redirect("/home");
}
