#!/usr/bin/env bash
set -uo pipefail
cd "$CLAUDE_PROJECT_DIR" || exit 0
echo "branch: $(git branch --show-current 2>/dev/null)"
n=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "$n" != "0" ] && echo "uncommitted: $n file(s)"
# Cheap spec-drift signal: specs moving without code following.
d=$(git log -1 --format=%ct -- docs 2>/dev/null); c=$(git log -1 --format=%ct -- src 2>/dev/null)
if [ -n "$d" ] && [ -n "$c" ] && [ "$d" -gt "$c" ]; then
  echo "note: docs/ changed more recently than src/ — code may be behind the spec"
fi
exit 0
