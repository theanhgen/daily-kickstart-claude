#!/bin/bash
# Cron wrapper for haiku generation
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
. scripts/lib.sh
load_notify_config

# Pull latest before generating so each batch builds on current main. Sequential
# (not a separate cron line) to avoid the project-lock race: sync.sh releases the
# lock on exit before the generate loop below acquires it. A sync failure is
# non-fatal — we still generate locally and the daily/weekly jobs retry the push.
if ! scripts/sync.sh >> update.log 2>&1; then
    TAIL="$(tail -1 update.log 2>/dev/null || echo 'check update.log')"
    scripts/notify.sh error "$PROJECT_NAME pre-generate sync failed" "$TAIL" || true
fi

FAILED=0

for engine in claude codex agy; do
    if ! ENGINE="$engine" scripts/generate.sh >> kickstart.log 2>&1; then
        TAIL="$(tail -1 kickstart.log 2>/dev/null || echo 'check kickstart.log')"
        scripts/notify.sh error "$PROJECT_NAME generate [$engine] failed" "$TAIL" || true
        FAILED=1
    fi
done

exit "$FAILED"
