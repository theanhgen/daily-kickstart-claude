#!/bin/bash
# Warn before the claude engine's login runs out.
#
# Claude Code's OAuth refresh token has a fixed lifetime: refreshing the access
# token rewrites the credentials file but keeps refreshTokenExpiresAt, so the
# login dies on that date and every claude haiku after it fails. The CLI only
# says so ("Your login expires in N days") in an interactive session, which
# nobody opens on the Pi. Run this daily: inside the warning window it sends
# one ntfy alert with the exact time; once expired it sends an error instead.
#
# codex and agy are not checked: both refresh on their own with no fixed
# expiry recorded, and a failed run already alerts through generate.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"

ensure_project_dir
load_notify_config

CLAUDE_CREDENTIALS_FILE="${CLAUDE_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
AUTH_EXPIRY_WARN_DAYS="${AUTH_EXPIRY_WARN_DAYS:-3}"
HOST="$(hostname -s)"

if [ ! -f "$CLAUDE_CREDENTIALS_FILE" ]; then
    echo "$(date '+%F %T') no credentials file at $CLAUDE_CREDENTIALS_FILE"
    exit 0
fi

read -r EXPIRES_MS EXPIRES_AT < <(jq -r '
    .claudeAiOauth.refreshTokenExpiresAt // empty
    | "\(.) \(. / 1000 | floor | strflocaltime("%a %Y-%m-%d %H:%M"))"
' "$CLAUDE_CREDENTIALS_FILE") || true

if [ -z "${EXPIRES_MS:-}" ]; then
    echo "$(date '+%F %T') no refreshTokenExpiresAt in $CLAUDE_CREDENTIALS_FILE"
    exit 0
fi

SECONDS_LEFT=$((EXPIRES_MS / 1000 - $(date +%s)))
HOURS_LEFT=$((SECONDS_LEFT / 3600))
FIX="ssh $HOST, run claude, then /login"

echo "$(date '+%F %T') claude login expires $EXPIRES_AT (${HOURS_LEFT}h left)"

if [ "$SECONDS_LEFT" -le 0 ]; then
    "$SCRIPT_DIR/notify.sh" error "$PROJECT_NAME: claude login expired on $HOST" \
        "Expired $EXPIRES_AT. The claude engine fails until you log in again: $FIX."
elif [ "$SECONDS_LEFT" -le $((AUTH_EXPIRY_WARN_DAYS * 86400)) ]; then
    "$SCRIPT_DIR/notify.sh" warning "$PROJECT_NAME: claude login expires $EXPIRES_AT" \
        "On $HOST, ${HOURS_LEFT}h left. Log in again before then: $FIX."
fi
