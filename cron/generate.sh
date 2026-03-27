#!/bin/bash
# Cron wrapper for haiku generation
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/generate.sh >> kickstart.log 2>&1
