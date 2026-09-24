# 0013 — Preview gets its own database, never a copy of production

Status: Accepted · 2026-09-24 · BAN-148

## Context

Every Vercel Preview deployment was reading and writing the production database. The Neon
Marketplace integration connects one Neon project (`ledgerwick-db`) to the Vercel project
and writes one set of variables into Production, Preview and Development together, so
`DATABASE_URL` on Preview was production's `main` branch. Development was the same, which
meant `vercel env pull` wrote production credentials into `.env.local`.

Nobody noticed because a second Neon project, created by hand, had branches named
`production` and `dev`. The names looked authoritative; neither branch was connected to
anything Vercel deployed.

Production holds a real user's bank statements and a Google OAuth grant. Preview must not.

## Options

* **A. The integration's automatic preview branches.** Neon creates `preview/<git-branch>`
  for each Preview deployment. Each is a copy-on-write branch of production, so it
  carries production's data, including OAuth tokens. The integration offers no
  schema-only variant. Branches live as long as their deployment, six months by default,
  against a free-plan limit of ten.
* **A', per-PR schema-only branches from GitHub Actions.** Neon's `create-branch-action`
  can make schema-only branches, but provisioning then moves out of Vercel into CI, and
  the connection string has to be handed to the deploy by hand. A second deployment
  pipeline, for one developer.
* **B. One fixed, data-free Preview branch.** Created schema-only, then emptied and
  rebuilt from the migrations. Preview builds migrate it.

## Decision

**B.** The integration is connected to Production only. Preview and Development get plain
variables pointing at two branches of the same Neon project:

* `preview`: a schema-only root branch, rebuilt from `migrations/`. It has never held a
  production row.
* `local`: a child of `preview`, for `next dev`.

`npm run build` runs `scripts/migrate-preview.ts` first. On a Preview build, and only
there, it migrates `preview`. It refuses unless the host is exactly
`PREVIEW_DATABASE_HOST`.

## Why

Keeping production data out of Preview is the requirement, and A cannot meet it. A' can,
at the cost of owning branch provisioning in CI. B meets it with no new pipeline: one
branch, one build step, one variable to check against.

What B trades away:

* **Concurrent PRs share one schema.** Two open PRs that both add migrations collide.
  Drizzle skips a migration older than the newest one applied, so the second PR's
  migration is silently never run. Recovery is to rebuild `preview` by hand
  (`.github/workflows/README.md`). With one developer merging one branch at a time, this
  should be rare.
* **Preview never sees real data.** Anything that only goes wrong against production-shaped
  data will not show up in Preview.
* **Rebuilding is manual.** A schema-only branch has no parent to reset from.

The allowlist exists because of how this went wrong. A denylist naming production's host
would still let Preview migrate any other database it happened to resolve to.

`local` is kept separate from `preview` because `npm run db:migrate` applies migrations
that may never merge, or that get regenerated. On a shared branch they would stay in
Preview's migration record, and the timestamp rule above would hide later ones.

## Consequences

* Production migrations still happen only in CI's `migrate` job. `migrate-preview.ts` does
  nothing unless `VERCEL_ENV` is `preview`.
* Adding a database variable means deciding its scope. The integration's variables are
  Production only. Preview and Development use `DATABASE_URL` and `DATABASE_URL_UNPOOLED`,
  plus `PREVIEW_DATABASE_HOST` on Preview.
* If `preview` is recreated rather than rebuilt in place, its host changes, and both
  Preview database variables and `PREVIEW_DATABASE_HOST` must change with it. Otherwise
  every Preview build fails, which is the intended failure.
* `BLOB_READ_WRITE_TOKEN` is still shared by all environments, so Preview can reach
  production's blob store. That is outside this decision and tracked separately.
