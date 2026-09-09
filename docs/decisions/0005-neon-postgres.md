# 0005 — Neon for Postgres, and what Supabase was also carrying

Status: Accepted · 2026-09-08 · Supersedes the infrastructure portions of `0001` and `0004`

## Context

`0001` chose the Supabase-hosted Postgres instance, and `0004` built the data access layer
against it. That choice was made partly on a "one vendor" argument: Supabase supplied the
database, file storage, authentication, and a realtime channel, so V1 had one account to
provision and one piece of infrastructure to operate.

We have since switched the database to **Neon**.

## Decision

**Postgres is Neon.** Serverless Postgres, scale-to-zero, and a connection pooler in front
of it. Drizzle, the migration files, and the PGlite-backed test suite are all unaffected —
they speak Postgres, not Supabase, and `DATABASE_URL` remains the only binding.

The pooler detail in `src/db/client.ts` survives the move for the same reason it existed:
Neon's pooled endpoint (`-pooler` in the host) is PgBouncer in transaction mode, so
`prepare: false` is still required. Only the comment naming the vendor changes.

**Application-layer workspace isolation is unchanged**, and is now the only reasonable
option rather than merely the preferred one. `0001` chose it over row-level security
because the frontend never holds database credentials and there is no client-side query
surface for RLS to defend. Neon has no bundled auth issuing per-user JWTs at all, so the
RLS alternative that `0001` weighed no longer exists in the form it was weighed in. The
argument for the trade is unaffected; the invariant it protects is unchanged; the tests
that enforce it are unchanged.

## What this decision does not settle

The one-vendor rationale is gone, and two responsibilities Supabase was quietly carrying
now have no home. Both were left open by this decision and have since been settled — file storage by `0007`,
authentication by `0006`:

* **File storage** (§6) — Supabase Storage held every original document. This is load-
  bearing: `docs/architecture.md §2.1` makes original documents the source of truth, so
  V1 cannot ship without it.
* **Authentication** (§20) — Supabase Auth. `users.id` mirrors an external auth provider's
  user id (`0004`), which is a shape any provider can satisfy, so the schema does not
  block on this. Nothing else has been built against Supabase Auth, because auth has not
  been built at all.

Realtime is not an open decision. `docs/architecture.md §14` already listed polling as an
acceptable mechanism and called the choice an implementation detail; with Supabase gone,
V1 polls.

## Consequences

* A Neon project must be provisioned and `DATABASE_URL` set in Vercel and locally. Use the
  **pooled** connection string.
* Region should be the one nearest the user base; `0004` recorded ap-south-1 for the same
  reason, and Neon's equivalent is `ap-southeast-1` (Singapore) unless Neon has since
  added an India region — check at provisioning time rather than trusting this line.
* Tests are unaffected. PGlite runs the same migration files in-process, and no test ever
  reached Supabase.
* `0001` and `0004` are left as written. They are a record of what was decided and why, not
  a description of current infrastructure; this document is the pointer forward.
