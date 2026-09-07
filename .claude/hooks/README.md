# Hooks

Configured in `.claude/settings.json`. Each script reads the hook payload on stdin and
exits `2` to block with a message the agent sees.

| Hook                     | Script             | What it does                                                                                                         |
| ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| PreToolUse(Bash)         | `guard-bash.sh`    | Blocks destructive git/rm/deploy commands and any database command aimed at a non-local host.                        |
| PreToolUse(Write\|Edit)  | `guard-write.sh`   | Blocks writes to `.env*`, blocks edits to existing migrations (forward-only), warns on new markdown outside `docs/`. |
| PostToolUse(Write\|Edit) | `scan-secrets.sh`  | Runs `gitleaks` on the file when installed; falls back to a regex pass for common credential shapes.                 |
| PostToolUse(Write\|Edit) | `check-changed.sh` | `tsc --noEmit`, `eslint` and `prettier --write` on the changed file, then `vitest related` for it.                   |
| SessionStart             | `session-start.sh` | Branch, uncommitted count, and whether `docs/` is ahead of `src/`.                                                   |
| Stop                     | `stop-check.sh`    | Full typecheck and test suite, plus a scan for scratch files left in the tree.                                       |

## Principles

**Scoped, not exhaustive.** `check-changed.sh` runs only the tests related to the file just
edited. A hook that runs the whole suite on every keystroke costs more than it catches and
gets switched off within a day; the full suite runs once, at `Stop`.

**Blocking hooks say why.** Exit 2 with a message the agent can act on, not a bare failure.

**Guards are not permissions.** These stop plausible accidents. They are not a security
boundary — the permission system is.

## The git-level equivalent

These hooks only cover the agent. The same checks run for everyone via husky:

- `.husky/pre-commit` — lint-staged (eslint + prettier on staged files), typecheck, tests
- `.husky/commit-msg` — commitlint, conventional commits
- `.github/workflows/ci.yml` — typecheck, lint, format, tests, build, gitleaks, plus an
  advisory hygiene job

## Optional local step

`gitleaks` is not an npm dependency; `scan-secrets.sh` uses it when present and falls back
to regex when not. CI runs it regardless. To have it locally:

```
brew install gitleaks
```
