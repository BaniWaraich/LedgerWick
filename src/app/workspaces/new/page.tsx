/**
 * Create a workspace.
 *
 * A workspace is a business, so it is named by the person who owns it rather than guessed
 * from their Google profile — which is why a first sign-in lands here instead of silently
 * creating one.
 */

"use client";

import { useActionState } from "react";

import { createWorkspaceAction, type WorkspaceFormState } from "../actions";
import styles from "../workspaces.module.css";

const EMPTY: WorkspaceFormState = { error: null };

export default function NewWorkspacePage() {
  const [state, formAction, pending] = useActionState(createWorkspaceAction, EMPTY);

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.intro}>
          <h1 className={styles.title}>Create a workspace</h1>
          <p className={styles.subtitle}>Name it after the business it keeps the books for.</p>
        </div>

        <div className={styles.card}>
          <form action={formAction}>
            <label className={styles.label} htmlFor="name">
              Business name
            </label>
            <input
              className={styles.input}
              id="name"
              name="name"
              type="text"
              autoComplete="organization"
              required
            />
            <button className={styles.primaryButton} type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create workspace"}
            </button>
          </form>

          {state.error ? (
            <p className={styles.error} role="alert">
              {state.error}
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
