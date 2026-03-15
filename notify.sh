#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/kickstart-lib.sh"

ensure_project_dir
load_notify_config

SEVERITY="${1:-info}"
TITLE="${2:-$PROJECT_NAME}"
MESSAGE="${3:-}"

if [ -z "$MESSAGE" ]; then
    echo "Usage: $0 <info|warning|error> <title> <message>" >&2
    exit 1
fi

if [ -z "${NOTIFY_NTFY_URL:-}" ] && [ -z "${NOTIFY_NTFY_TOPIC:-}" ]; then
    exit 0
fi

if ! command -v curl > /dev/null 2>&1; then
    echo "notify.sh: curl is required for ntfy notifications" >&2
    exit 1
fi

NOTIFY_NTFY_HOST="${NOTIFY_NTFY_HOST:-https://ntfy.sh}"
NTFY_URL="${NOTIFY_NTFY_URL:-$NOTIFY_NTFY_HOST/$NOTIFY_NTFY_TOPIC}"

case "$SEVERITY" in
    info)
        PRIORITY="3"
        ;;
    warning)
        PRIORITY="4"
        ;;
    error|critical)
        PRIORITY="5"
        ;;
    *)
        PRIORITY="3"
        ;;
esac

printf '%s\n' "$MESSAGE" | curl -fsS \
    -H "Title: $TITLE" \
    -H "Priority: $PRIORITY" \
    -H "Tags: $PROJECT_NAME" \
    -d @- \
    "$NTFY_URL" > /dev/null
