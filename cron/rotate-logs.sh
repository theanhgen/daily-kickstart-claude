#!/bin/bash
# Cron wrapper for log rotation
set -euo pipefail
cd "$(dirname "$0")/.."

# Rotate kickstart.log
if [ -f kickstart.log ]; then
    mv kickstart.log "kickstart.log.$(date +%Y%m%d)"
    find . -maxdepth 1 -name "kickstart.log.*" -mtime +30 -delete
fi

# Rotate update.log
if [ -f update.log ]; then
    mv update.log "update.log.$(date +%Y%m%d)"
    find . -maxdepth 1 -name "update.log.*" -mtime +30 -delete
fi

# Rotate healthcheck.log
if [ -f healthcheck.log ]; then
    mv healthcheck.log "healthcheck.log.$(date +%Y%m%d)"
    find . -maxdepth 1 -name "healthcheck.log.*" -mtime +30 -delete
fi
