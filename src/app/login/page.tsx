/**
 * Sign in.
 *
 * Google is the only way in (docs/decisions/0006-authentication.md), so there is no email
 * field, no password, and no separate sign-up: a first sign-in creates the account. The
 * `sign_up` and `forgot_password` wireframes predate that decision and are not built.
 *
 * Deliberately unstyled beyond the essentials — the application shell is feature A's last
 * task, and phase-1.md §9 defers UI polish to the feature that needs it.
 */

import { signIn } from "../../auth/config";

export default function LoginPage() {
  async function signInWithGoogle() {
    "use server";
    // Auth.js builds the authorization request from src/auth/google.ts: profile and email
    // only. The Gmail scope is requested separately, by feature J, at connect time.
    await signIn("google", { redirectTo: "/home" });
  }

  return (
    <main>
      <h1>Sign in to Ledgerwick</h1>
      <form action={signInWithGoogle}>
        <button type="submit">Continue with Google</button>
      </form>
    </main>
  );
}
