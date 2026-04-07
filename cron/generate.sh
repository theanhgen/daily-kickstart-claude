#!/bin/bash
# Cron wrapper for haiku generation
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
. scripts/lib.sh
load_notify_config

FAILED=0

for engine in claude codex; do
    if ! ENGINE="$engine" scripts/generate.sh >> kickstart.log 2>&1; then
        TAIL="$(tail -1 kickstart.log 2>/dev/null || echo 'check kickstart.log')"
        scripts/notify.sh error "$PROJECT_NAME generate [$engine] failed" "$TAIL" || true
        FAILED=1
    fi
done

exit "$FAILED"
