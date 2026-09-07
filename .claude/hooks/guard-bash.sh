#!/usr/bin/env bash
# PreToolUse(Bash): refuse commands that are destructive or that touch a remote database.
# stdin: hook JSON. exit 2 = block, message on stderr goes back to the model.
set -uo pipefail

cmd=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null) || exit 0
[ -z "$cmd" ] && exit 0

block() { echo "BLOCKED: $1" >&2; exit 2; }

case "$cmd" in
  *"rm -rf /"*|*"rm -rf ~"*|*"rm -fr /"*)  block "destructive recursive delete of a root path" ;;
  *"git push"*"--force"*|*"git push"*" -f "*) block "force push. Use --force-with-lease, and only when the user asked" ;;
  *"git reset --hard"*)                    block "git reset --hard discards uncommitted work. Ask the user first" ;;
  *"git checkout ."*|*"git restore ."*)    block "this discards all uncommitted changes. Ask the user first" ;;
  *"git clean -"*[fd]*)                    block "git clean deletes untracked files. Ask the user first" ;;
  *"supabase db reset"*)                   block "db reset drops all data. Ask the user first" ;;
  *"vercel --prod"*|*"vercel deploy --prod"*) block "production deploy. Only on an explicit request from the user" ;;
  *"npm publish"*)                         block "publishing to npm" ;;
esac

# Any psql / migration command pointed at something that is not localhost.
# Installing packages is not running a migration — npm/pnpm/yarn lines are exempt,
# or an `npm i drizzle-kit @scope/pkg` trips the connection-string check on its `@`.
if echo "$cmd" | grep -qE '(^|[;&|] *)(psql|npx +drizzle-kit|drizzle-kit|prisma +migrate|supabase +db +push)' &&
   ! echo "$cmd" | grep -qE '(^|[;&|] *)(npm|pnpm|yarn|bun) +(i|install|add|remove|uninstall|ci)\b'; then
  # Only a real connection string counts as a host, not a bare @ (npm scopes contain @).
  if echo "$cmd" | grep -qE 'postgres(ql)?://[^ ]*' && ! echo "$cmd" | grep -qE 'postgres(ql)?://[^ ]*(localhost|127\.0\.0\.1)'; then
    block "database command against a non-local host. Run migrations against local only"
  fi
fi
exit 0
