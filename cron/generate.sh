#!/bin/bash
# Cron wrapper for haiku generation
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
. scripts/lib.sh
load_notify_config

if ! scripts/generate.sh >> kickstart.log 2>&1; then
    TAIL="$(tail -1 kickstart.log 2>/dev/null || echo 'check kickstart.log')"
    scripts/notify.sh error "$PROJECT_NAME generate failed" "$TAIL" || true
    exit 1
fi
