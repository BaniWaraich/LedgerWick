#!/usr/bin/env bash
# PostToolUse(Write|Edit): catch a credential written into a tracked file.
set -uo pipefail

path=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null) || exit 0
[ -f "$path" ] || exit 0

# Prefer gitleaks when it is installed; the regex pass below is the fallback.
if command -v gitleaks >/dev/null 2>&1; then
  if ! out=$(gitleaks detect --no-git --source "$path" --redact 2>&1); then
    echo "BLOCKED: gitleaks flagged a secret in $path" >&2
    echo "$out" | tail -20 >&2
    exit 2
  fi
  exit 0
fi

if grep -nEi \
  -e '(service_role|supabase)[_a-z]*(key|secret)[[:space:]]*[:=][[:space:]]*['"'"'"][A-Za-z0-9._-]{20,}' \
  -e 'sk-[A-Za-z0-9]{20,}' \
  -e 'ghp_[A-Za-z0-9]{30,}' \
  -e 'BEGIN [A-Z ]*PRIVATE KEY' \
  -e '(client_secret|refresh_token|access_token)[[:space:]]*[:=][[:space:]]*['"'"'"][A-Za-z0-9._\-]{20,}' \
  "$path" >&2; then
  echo "BLOCKED: that looks like a real credential. Read it from the environment instead." >&2
  exit 2
fi
exit 0
