#!/usr/bin/env bash
# PreToolUse(Write|Edit): protect secrets and applied migrations; keep the repo tidy.
set -uo pipefail

path=$(python3 -c 'import json,sys; d=json.load(sys.stdin).get("tool_input",{}); print(d.get("file_path",""))' 2>/dev/null) || exit 0
[ -z "$path" ] && exit 0

rel="${path#"$CLAUDE_PROJECT_DIR/"}"
base=$(basename "$path")

case "$base" in
  .env|.env.*)
    echo "BLOCKED: never write .env files. Ask the user to set the value themselves." >&2; exit 2 ;;
esac

# Forward-only migrations: an existing migration file has probably already been applied.
if [[ "$rel" == migrations/* || "$rel" == */migrations/* ]] && [ -f "$path" ]; then
  echo "BLOCKED: $rel already exists. Migrations are forward-only — add a new one instead (docs/decisions/README.md)." >&2
  exit 2
fi

# AGENTS.md #7: keep the repository clean.
if [[ "$rel" == *.md && "$rel" != docs/* && "$rel" != *AGENTS.md && "$rel" != *CLAUDE.md && "$rel" != README.md ]]; then
  echo "Note: new markdown outside docs/ — confirm this file is needed (AGENTS.md #7)." >&2
  exit 0
fi
exit 0
