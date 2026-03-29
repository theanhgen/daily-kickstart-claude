#!/bin/bash
# Cron wrapper for git sync
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
. scripts/lib.sh
load_notify_config

if ! scripts/sync.sh >> update.log 2>&1; then
    TAIL="$(tail -1 update.log 2>/dev/null || echo 'check update.log')"
    scripts/notify.sh error "$PROJECT_NAME sync failed" "$TAIL" || true
    exit 1
fi
