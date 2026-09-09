/**
 * Auth.js configuration.
 *
 * Identity is Google, and Google alone (docs/decisions/0006-authentication.md). Sessions
 * live in the database rather than in a JWT: ADR 0006 asks for session storage, feature J
 * needs the `accounts` row regardless, and a stored session can be revoked.
 *
 * The config is a function rather than an object because `getDb()` throws when
 * DATABASE_URL is unset, and Next evaluates top-level module code at build time. The
 * function form defers the connection to the first request, which is the same reason
 * `src/db/client.ts` is lazy.
 */

import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import { getDb } from "../db/client";
import { accounts, sessions, users, verificationTokens } from "../db/schema";
import { googleProvider } from "./google";

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [googleProvider],
  session: { strategy: "database" },
  // Our own sign-in page, not Auth.js's default one.
  pages: { signIn: "/login" },
}));
