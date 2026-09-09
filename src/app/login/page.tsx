/**
 * Sign in.
 *
 * Google is the only way in (docs/decisions/0006-authentication.md), so a first sign-in is
 * also registration: there is no sign-up form and no password to forget. The `sign_up` and
 * `forgot_password` wireframes predate that decision and are deliberately not built, and
 * the email/password half of the `log_in` wireframe is dropped for the same reason. What
 * is kept is its visual language -- the centred card, the headline, the Google button.
 */

import { signIn } from "../../auth/config";
import styles from "./page.module.css";

export default function LoginPage() {
  async function signInWithGoogle() {
    "use server";
    // The authorization request is built from src/auth/google.ts: profile and email only.
    // The Gmail scope is requested separately, by feature J, at mailbox-connect time.
    await signIn("google", { redirectTo: "/home" });
  }

  return (
    <main className={styles.page}>
      <div className={styles.panel}>
        <div className={styles.intro}>
          <h1 className={styles.brand}>Ledgerwick</h1>
          <p className={styles.subtitle}>Sign in to your account</p>
        </div>

        <div className={styles.card}>
          <form action={signInWithGoogle}>
            <button className={styles.googleButton} type="submit">
              <svg className={styles.googleMark} viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.64h6.2a5.3 5.3 0 0 1-2.3 3.47v2.89h3.72c2.18-2 3.44-4.96 3.44-8.55Z"
                />
                <path
                  fill="#34A853"
                  d="M12 23.5c3.11 0 5.72-1.03 7.62-2.8l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.540-2.03-6.45-4.75H1.7v2.98A11.5 11.5 0 0 0 12 23.5Z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.55 14.16a6.9 6.9 0 0 1 0-4.32V6.86H1.7a11.5 11.5 0 0 0 0 10.28l3.85-2.98Z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.77c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.72 1.3 15.11.5 12 .5A11.5 11.5 0 0 0 1.7 6.86l3.85 2.98C6.46 7.12 9 4.77 12 4.77Z"
                />
              </svg>
              Continue with Google
            </button>
          </form>

          <p className={styles.note}>
            Signing in with Google creates your account if you do not have one.
          </p>
        </div>
      </div>
    </main>
  );
}
