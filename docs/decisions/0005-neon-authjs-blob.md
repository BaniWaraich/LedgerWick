# 0005 — Neon, Auth.js, and Vercel Blob

Status: Accepted · 2026-09-08

Supersedes the Supabase Postgres and Supabase Auth decisions in
`docs/decisions/0001-spec-reconciliation.md`, and the Supabase references in
`docs/decisions/0004-data-access.md`. Replaces Supabase Storage as fixed by
`docs/architecture.md §6`.

## Context

Decision 0001 recorded "the Supabase-hosted Postgres instance" and "Authentication is
Supabase Auth". Neither was the result of a comparison.

The honest provenance: `docs/architecture.md` already fixed Supabase Storage and mentioned
Supabase Realtime, both written before implementation began. The database line said only
"PostgreSQL" and the authentication line said *"To be finalized within the chosen
application stack."* Decision 0001 filled both blanks with Supabase on the strength of
adjacency — one vendor rather than three — and no evaluation of alternatives on pricing,
region, or features was performed.

The authentication choice was the worse of the two. It had been explicitly deferred in the
architecture document, and 0001 closed it while marking three lesser questions as open. It
should have stayed open.

Reopened on review, with the objection that Supabase bundles a vendor-specific auth layer
the product would then be tied to.

## What was actually coupled

Verified rather than assumed, before deciding anything:

* no `@supabase/*` package was ever installed,
* the schema has no reference to `auth.users`; `users` is a standalone table,
* `workspace-scope.ts` is plain Drizzle and Postgres,
* `prepare: false` in the client is required by any transaction-mode pooler, not by
  Supabase specifically,
* three source comments mentioned Supabase; nothing else did.

The decision that could have coupled the system did not: choosing application-layer
isolation over row-level security (0001, 0004) avoided binding authorization to Supabase's
`auth.uid()` JWT integration. Had RLS been chosen, this would have been a rewrite rather
than an environment variable.

## Decision

### Database — Neon, `aws-ap-southeast-1` (Singapore)

Postgres and nothing else. No bundled auth, no bundled storage, so no bundled lock-in.

**This costs the Mumbai region.** Neon has eight AWS regions and `ap-south-1` is not among
them; Singapore is the closest. The earlier residency preference — keep Indian businesses'
bank statement data in India — is knowingly traded away.

That trade was made explicitly, with the alternative on the table: Supabase Postgres in
Mumbai with Auth.js on top would have satisfied both goals, since the objection was to the
bundled auth layer rather than to Supabase's Postgres. It was declined in favour of a
Postgres-only vendor.

**Revisit if Indian data residency turns out to be a legal requirement rather than a
preference.** RBI's localization mandate is aimed at payment system operators and may not
reach a bookkeeping tool; the DPDP Act permits cross-border transfer except to restricted
countries. Neither question has been answered by anyone qualified to answer it. If the
answer comes back as "required", this decision is wrong and the migration is a database
move plus a region-locked host.

### Authentication — Auth.js, Google first

Identities live in this project's own Postgres, through the Drizzle adapter. No auth
vendor holds the user table.

Clerk was the alternative and is faster to working software, with drop-in UI and MFA. It
was rejected on the stated criterion: it is a vendor-specific auth layer, so adopting it
would have changed which vendor owned the identities rather than removing the tie. Identity
lock-in is the expensive kind — migrating providers usually means abandoning password
hashes and forcing a reset on every user.

Google first, because **the product already requires Google OAuth** for Gmail retrieval.
Sign-in reuses a dependency that exists regardless, and no password is ever stored.

**Sign-in scopes stay separate from Gmail scopes.** Sign-in uses basic profile scopes
only; the Restricted Gmail scopes are requested later, at connect time
(`docs/workflows/connect-gmail.md §5`). Combining them would gate sign-in itself on CASA
approval, which would make the product unusable before launch.

The cost is real: session handling, the sign-in surface, and account recovery become this
project's responsibility rather than a vendor's.

### Document storage — Vercel Blob

First-party, supports private access, and removes the last reason to hold a Supabase
account. Documents are private and served through authorized application routes, never a
public URL (`docs/architecture.md §19`) — unchanged by the move.

### Processing updates — polling

`docs/architecture.md §14` already allowed polling or Supabase Realtime. Polling, now.

## Consequences

* `DATABASE_URL` points at Neon. Nothing else in the data layer changes.
* Auth.js requires its own tables (users, accounts, sessions, verification tokens) in the
  next migration, and `users` becomes the Auth.js user table rather than a mirror of an
  external identity.
* Three vendors instead of one: Neon, Vercel, Google. Accepted as the price of not being
  bundled.
* Indian bank statement data will be stored in Singapore until and unless this is revisited.
