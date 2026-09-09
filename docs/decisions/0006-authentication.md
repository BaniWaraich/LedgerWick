# 0006 — Auth.js with Google as the identity provider

Status: Accepted · 2026-09-08 · Closes the authentication OPEN DECISION in `architecture.md §20`

## Context

Authentication was Supabase Auth while Supabase supplied the database. It no longer does
(`0005`), and authentication had not been built, so nothing was migrated — the question was
simply reopened.

One constraint dominates the choice. `docs/workflows/connect-gmail.md` requires Google
OAuth with Gmail scopes no matter how sign-in works. Any provider that is not Google means
the user authenticates twice, against two identities that then have to be reconciled.

## Options

* **Auth.js (NextAuth) with the Google provider** — self-hosted sessions, no extra vendor.
* **Clerk** — hosted identity, native Vercel Marketplace integration, fastest to stand up.
* **Better Auth** — self-hosted, Drizzle-native adapter.

## Decision

**Auth.js with the Google provider.**

Sign-in and Gmail connection are then the same identity and the same consent surface.

## Why

The deciding factor is not sign-in; it is the Gmail scope. `gmail.readonly` is a
**Restricted** scope: it triggers the CASA assessment discussed in `connect-gmail.md`, and
asking for it at sign-up degrades consent for every user including those who never connect
a mailbox. Auth.js exposes the underlying authorization request directly, so the Gmail
scope can be requested **incrementally** — a second, separate consent at the moment the
user connects a mailbox, with the basic profile scope alone at sign-up.

Clerk owns the Google connection, which makes incremental authorization for a scope Clerk
does not model an indirect exercise. That is the wrong thing to have between us and the
single most sensitive permission in the product.

What is traded away: session handling, account linking, and the sign-in UI are ours to
build and keep correct. That is real work Clerk would have absorbed.

## Consequences

* `users.id` continues to mirror the provider's user id (`0004`) — here, the Google `sub`
  claim, which is stable and never reassigned.
* Sign-up requests profile scopes only. **The Gmail scope is never requested at sign-up.**
* Google OAuth credentials are secrets: server-side only, never returned to the frontend,
  never logged (`docs/definition-of-done.md`).
* Auth.js needs session storage. It uses the same Neon database through Drizzle, which
  means an adapter and a migration adding its tables. Those tables are **not**
  workspace-scoped and must not be added to `workspaceScopedTables`.
* Every authenticated route derives `userId` from the session on the server. A workspace id
  arriving from the client is checked against it by `openWorkspace`, never trusted.
