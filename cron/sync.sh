#!/bin/bash
# Cron wrapper for git sync
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/sync.sh >> update.log 2>&1
