#!/bin/bash
# Cron wrapper for the claude login-expiry check
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/auth-expiry.sh >> auth-expiry.log 2>&1
