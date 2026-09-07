# CI

`ci.yml` runs on every pull request and on pushes to `main`.

| Job       | Blocking | What                                                  |
| --------- | -------- | ----------------------------------------------------- |
| `verify`  | yes      | typecheck, lint, format check, tests, build           |
| `hygiene` | no       | knip (dead code), depcheck (unused deps), `npm audit` |
| `secrets` | yes      | gitleaks over full history                            |

`hygiene` is advisory on purpose. Dead-code and dependency reports are noisy on a young
codebase, and a merge blocked on a false positive teaches people to ignore CI. It reports;
it does not gate.

## Why hygiene is currently red

**It is expected to be red, and has been since it was added.** `npm audit` reports a
high-severity postcss advisory that reaches us transitively through Next 15. Fixing it
requires Next 16, which is deferred — see `docs/decisions/0002-defer-next-16-upgrade.md`.

So a red `hygiene` job is not by itself a signal that anything changed. Open the log and
check whether the failure is the known audit finding or something new. `knip` and
`depcheck` failing _are_ new findings and worth acting on.

This will stay red until the Next 16 upgrade lands, at which point the job should go green
and stay that way.

Deployment is handled by Vercel's own GitHub integration — preview per PR, production on
`main`. CI here verifies; it does not deploy, and deployment is not gated on it. If that
gating is wanted, enable "wait for CI" in the Vercel project's Git settings rather than
adding a deploy step here.

## Branch protection

Not configured by this repository. To make CI meaningful, require the `verify` and
`secrets` checks on `main` in the repository settings.
