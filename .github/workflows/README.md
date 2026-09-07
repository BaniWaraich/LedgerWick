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

## Branch protection

Not configured by this repository. To make CI meaningful, require the `verify` and
`secrets` checks on `main` in the repository settings.
