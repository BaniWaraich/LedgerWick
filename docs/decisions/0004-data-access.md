# 0004 — Drizzle, integer money, and a scope object for isolation

Status: Accepted · 2026-09-07

## Context

The domain model named the entities; nothing implemented them. Three choices had to be
made before the first table existed, and each is expensive to revisit later.

## Decision 1 — Drizzle ORM with postgres-js

Schema is TypeScript, migrations are generated SQL that can be read before they run.

Prisma was the alternative. Rejected because its migration path is more opaque and its
client is a heavier abstraction over SQL, and the invariants here (partial unique indexes,
a composite identity index) are things we want to state in SQL and read back in SQL.

Migrations are forward-only. `strict: true` in `drizzle.config.ts`; never edit an applied
migration.

## Decision 2 — Money as integer minor units

Amounts are `bigint` columns holding paise or cents, with an explicit currency alongside.
Never a float, and not `numeric`.

The balance equation adds thousands of these and must be exact. Floats are disqualified
outright. `numeric` is exact but arrives as a string and invites accidental `Number()`
coercion at some call site nobody is looking at; integers cannot be silently corrupted
that way, and JavaScript's `bigint` is exact past 2^53.

Cost: every read and write converts, and minor-unit exponents vary by currency. Accepted —
the conversion is visible, whereas float drift is not.

## Decision 3 — Isolation through a scope object, not a convention

`openWorkspace(db, userId, workspaceId)` verifies membership once and returns a
`WorkspaceScope`. Every query for workspace-scoped data goes through that scope, which
injects the filter. There is no exported helper that reads a workspace-scoped table
without one.

This follows from decision 0001 choosing application-layer isolation over RLS: a single
forgotten `where` is a data leak with nothing behind it. So the workspace is not something
a caller remembers to pass — it is the object you must hold to reach the data at all.

Specifically:

* `insert` **injects** `workspaceId` rather than accepting it, so a caller cannot write
  into another workspace even by supplying its id.
* `update` and `delete` apply the workspace filter on top of any caller predicate.
* `WorkspaceAccessError` reads identically for "not yours" and "does not exist". A
  distinguishable message enumerates workspace ids.
* A new workspace-scoped table must be added to `workspaceScopedTables`, which is
  deliberate friction rather than an oversight.

The escape hatch is `getDb()`, which still returns an unscoped client — needed for
migrations, for the workspace list itself, and for tests. It is not a secret; the point is
that the scoped path is the easy one and the unscoped path is visible in review.

### Cost

Drizzle's builder types do not generalise over a union of tables, so four methods in
`workspace-scope.ts` carry `as never` casts. They are confined to those bodies and callers
remain fully typed from the table they pass. This is a real wart, accepted in exchange for
the enforcement.

## Testing

Schema tests run on PGlite — real Postgres compiled to WASM, in-process. No Docker daemon,
no CI service container, same migrations that run against Supabase.

Two suites, both required by `docs/definition-of-done.md`:

* `tests/db/workspace-isolation.test.ts` — written as attacks. Each test tries to reach
  another workspace's data and asserts it cannot, including the case of two workspaces
  owned by the *same user*, which catches isolation written as "is this the user's data".
* `tests/db/invariants.test.ts` — asserts the constraints in the migration, by SQLSTATE
  23505 and by constraint name, so a test cannot pass on the wrong error.

## Consequences

* **Superseded by 0005:** the database is Neon in `aws-ap-southeast-1`, not Supabase in
  ap-south-1. `DATABASE_URL` must still be set in Vercel and locally before anything
  connects; nothing else in this decision changes, which was the point of keeping the data
  layer provider-neutral.
* Statement Coverage is derived from `bank_statements.period_start/period_end` rather than
  stored, so there is no second copy to fall out of sync.
* `users` is a standalone table rather than a reference to any provider's identity table,
  so the schema stands alone and tests need no auth schema. Under 0005 it becomes the
  Auth.js user table.
* tsconfig `target` moved to ES2022 for bigint literals — well inside Next 16's browser
  floor.
