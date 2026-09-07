# 0002 — Defer the Next 16 upgrade

Status: Accepted · 2026-09-07

## Context

The first CI run surfaced a high-severity `npm audit` finding: a path-traversal advisory in
postcss (`sourceMappingURL` auto-loading arbitrary `.map` files), reaching the project
transitively through Next 15. The only non-forced fix is Next 16.

A second, unrelated constraint points the same way. ESLint is pinned to 9 because
`eslint-config-next@15` peers to `^7 || ^8 || ^9`; ESLint 10 requires Next 16. One upgrade
would clear both.

## Options

1. `npm audit fix --force`. Rejected: it performs the major upgrade as a side effect of an
   audit command, which is not how a framework migration should arrive.
2. Upgrade to Next 16 now, purely to clear the advisory. Rejected: an advisory that does
   not apply is a poor reason to take a breaking change mid-task.
3. Defer, with a recorded trigger. Chosen.

## Decision

Stay on Next 15. Do not force the postcss version.

The advisory requires postcss to process attacker-controlled CSS. This application runs
postcss only over CSS committed to the repository, at build time. No feature accepts CSS,
or anything reaching a postcss call, from a user. The exploit path does not exist here
today.

## Revisit

**Immediately — not eventually — if any feature accepts CSS or CSS-adjacent input from a
user.** Custom themes, uploaded stylesheets, user-supplied styling of any kind. At that
point this stops being build-time-only and must be resolved *before* that feature ships.

**Separately, on its own merits, before the first real feature slice.** The timing question
is worth deciding independently of this advisory: one Next 16 upgrade clears both the
postcss finding and the ESLint 9 pin, and the migration surface is smallest while the app
is three pages. It only grows from here.

## Consequences

* The `hygiene` CI job fails on the audit step until the upgrade lands. This is expected
  and is not a regression. Noted in `.github/workflows/ci.yml` and its README so a red run
  is not mistaken for a new problem.
* `knip` and `depcheck` failures within that same job *are* new findings. The log has to be
  read rather than the job's colour trusted.
* ESLint stays on 9 until the upgrade.
