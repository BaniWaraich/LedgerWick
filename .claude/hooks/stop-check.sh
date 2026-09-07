#!/usr/bin/env bash
# Stop: full suite once, plus a scan for scratch files left in the tree.
set -uo pipefail
cd "$CLAUDE_PROJECT_DIR" || exit 0

fail=""
npx --no-install tsc --noEmit >/tmp/lw-tsc.log 2>&1 || fail="typecheck failing (see /tmp/lw-tsc.log)"
npm test --silent >/tmp/lw-test.log 2>&1 || fail="${fail:+$fail; }tests failing (see /tmp/lw-test.log)"

stray=$(git status --porcelain 2>/dev/null | grep '^??' | grep -Ei '\.(log|tmp|bak|orig)$|(^|/)(scratch|tmp|temp)/' | head -5)
[ -n "$stray" ] && fail="${fail:+$fail; }untracked scratch files: $(echo "$stray" | tr '\n' ' ')"

[ -n "$fail" ] && { echo "$fail" >&2; exit 2; }
exit 0
