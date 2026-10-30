#!/bin/sh
# Tether: Claude Code PermissionRequest hook. In a daemon job (CLAUDE_JOB_DIR
# set) it asks the job's chat in Tether and waits for the answer; it prints
# Tether's decision, or nothing (Claude Code's own prompt then applies). In any
# other session it does nothing.
# The token sits next to the database (DATABASE_PATH); set TETHER_HOOK_TOKEN_FILE
# and TETHER_HOOK_URL if yours is elsewhere or the port is not 3001.
#
# settings.json:
#   "hooks": { "PermissionRequest": [ { "matcher": "*", "hooks": [
#     { "type": "command", "command": "/opt/tether/deploy/permission-hook.sh", "timeout": 130 } ] } ] }
[ -n "${CLAUDE_JOB_DIR:-}" ] || exit 0
TOKEN_FILE="${TETHER_HOOK_TOKEN_FILE:-$HOME/.cloudcli/job-permission-hook.token}"
URL="${TETHER_HOOK_URL:-http://127.0.0.1:3001/api/live-hook/permission}"
[ -r "$TOKEN_FILE" ] || exit 0
# Tether waits at most 110 s for an answer; never block the job longer.
curl -s --max-time 120 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Tether-Hook-Token: $(cat "$TOKEN_FILE")" \
  --data-binary @- 2>/dev/null || true
exit 0
