# CI

`ci.yml` runs on every pull request and on pushes to `main`.

| Job       | Blocking | What                                                           |
| --------- | -------- | -------------------------------------------------------------- |
| `verify`  | yes      | typecheck, lint, format check, tests, build                    |
| `hygiene` | no       | knip (dead code), depcheck (unused deps), `npm audit`          |
| `migrate` | yes      | applies pending migrations to production (push to `main` only) |
| `secrets` | yes      | gitleaks over full history                                     |

`hygiene` is advisory on purpose. Dead-code and dependency reports are noisy on a young
codebase, and a merge blocked on a false positive teaches people to ignore CI. It reports;
it does not gate.

## Reading a red hygiene job

The audit finding that made this job red from the day it was added is gone — Next 16
landed in #1 and `npm audit` reports zero vulnerabilities. See
`docs/decisions/0002-defer-next-16-upgrade.md`, now resolved.

So a red hygiene job means something again. Open the log and read it:

- **`npm audit`** — a new advisory. Worth a decision, and worth recording if the answer is
  to defer.
- **`knip`** — dead code. Usually real. Delete it rather than suppressing it
  (`AGENTS.md` #7).
- **`depcheck`** — a dependency nothing imports.

It stays advisory rather than blocking, because these reports are noisy on a young
codebase and a merge stopped by a false positive teaches people to ignore CI. Advisory
does not mean ignorable.

## If `npm ci` fails with "Missing: @emnapi/... from lock file"

This has happened twice. It is not a real dependency problem.

`@emnapi/core` and `@emnapi/runtime` arrive as optional, platform-specific
dependencies of the resolver that `eslint-config-next` pulls in. An incremental
`npm install` on macOS records them nested under the wasm binding package; a Linux
install expects them hoisted to the top level. The lock is then valid locally and
unusable in CI.

Incremental installs reintroduce it, so after any dependency change that alters the
lock, regenerate it cleanly rather than trusting the incremental result:

```
npm run lock:refresh
```

Then commit the lockfile. Verify before pushing:

```
node -e "const l=require('./package-lock.json'); console.log(['node_modules/@emnapi/core','node_modules/@emnapi/runtime'].filter(k=>l.packages[k]))"
```

Both paths should be listed. If they are not, CI will fail.

## `migrate`

Schema changes reach production through this job and nowhere else. A file in
`migrations/` is inert until something runs it against a database; `npm run db:migrate` is
hardcoded to `.env.local`, so it only ever updates the database a developer is pointed at.
Without this job, production drifts silently — which it did, three migrations deep, until
an upload failed on a missing `content_hash` column.

It runs only on pushes to `main`, after `verify` passes, and serializes on a concurrency
group so two runs cannot migrate one database at once.

### It does not gate the deploy

Vercel deploys on push independently of GitHub Actions, so this job and the deploy race.
That is safe while migrations are additive: a new nullable column does no harm whichever
order the two land in, because the old code never mentions it.

It is **not** safe for a migration that drops a column, renames one, or rewrites data. Ship
those in two deploys — the schema change first, then the code that depends on it. If that
ever becomes routine, the real fix is to turn off Vercel's git auto-deploy and deploy from
CI after this job, so the ordering is guaranteed rather than assumed.

### Required secret

`PRODUCTION_DATABASE_URL_UNPOOLED` — the production branch's **direct** (non-pooled) Neon
connection string, set in the repository's Actions secrets. Neon's pooler is not reliable
for DDL. The job fails loudly when the secret is missing, because `drizzle-kit` with an
empty URL is silent about connecting to nothing.

## Branch protection

Not configured by this repository. To make CI meaningful, require the `verify` and
`secrets` checks on `main` in the repository settings.
