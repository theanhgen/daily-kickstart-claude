#!/bin/bash
# Cron wrapper for health checks
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/healthcheck.sh >> healthcheck.log 2>&1
