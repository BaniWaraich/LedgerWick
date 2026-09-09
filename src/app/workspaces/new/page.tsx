/**
 * Create a workspace.
 *
 * A workspace is a business, so it is named by the person who owns it rather than guessed
 * from their Google profile. Minimal on purpose; the shell is feature A's last task.
 */

"use client";

import { useActionState } from "react";

import { createWorkspaceAction, type WorkspaceFormState } from "../actions";

const EMPTY: WorkspaceFormState = { error: null };

export default function NewWorkspacePage() {
  const [state, formAction, pending] = useActionState(createWorkspaceAction, EMPTY);

  return (
    <main>
      <h1>Create a workspace</h1>
      <form action={formAction}>
        <label htmlFor="name">Business name</label>
        <input id="name" name="name" type="text" autoComplete="organization" required />
        <button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create workspace"}
        </button>
      </form>
      {state.error ? <p role="alert">{state.error}</p> : null}
    </main>
  );
}
