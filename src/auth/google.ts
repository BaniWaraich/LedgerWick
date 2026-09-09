/**
 * What sign-in asks Google for.
 *
 * Kept apart from `config.ts` so the scopes can be asserted without constructing Auth.js
 * itself — this module pulls in no Next runtime, so the guard in
 * `tests/auth/sign-in-scopes.test.ts` is a plain unit test over the provider that ships.
 */

import Google from "next-auth/providers/google";

/**
 * Profile and email — nothing else.
 *
 * `gmail.readonly` is a Restricted scope and is **never** requested here. Feature J
 * requests it incrementally, at mailbox-connect time (ADR 0006: "The Gmail scope is never
 * requested at sign-up"). Asking for it at sign-up would degrade consent for every user,
 * including those who never connect a mailbox.
 */
export const SIGN_IN_SCOPES = ["openid", "email", "profile"] as const;

export const googleProvider = Google({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  authorization: { params: { scope: SIGN_IN_SCOPES.join(" ") } },
});
