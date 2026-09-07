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
