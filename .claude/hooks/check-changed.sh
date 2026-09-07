#!/usr/bin/env bash
# PostToolUse(Write|Edit): typecheck, plus the tests related to the file just changed.
set -uo pipefail
cd "$CLAUDE_PROJECT_DIR" || exit 0

path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null) || exit 0
case "$path" in *.ts|*.tsx) ;; *) exit 0 ;; esac

if ! out=$(npx --no-install tsc --noEmit 2>&1); then
  echo "Type errors:" >&2
  echo "$out" | head -30 >&2
  exit 2
fi

rel_lint="${path#"$CLAUDE_PROJECT_DIR/"}"
if ! out=$(npx --no-install eslint "$rel_lint" 2>&1); then
  echo "Lint errors in $rel_lint:" >&2
  echo "$out" | head -30 >&2
  exit 2
fi
npx --no-install prettier --write "$rel_lint" >/dev/null 2>&1

rel="$rel_lint"
if ! out=$(npx --no-install vitest related "$rel" --run 2>&1); then
  echo "Related tests failing for $rel:" >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
exit 0
