#!/bin/bash
# Cron wrapper for git updates
cd "$(dirname "$0")"
./sync-now.sh >> update.log 2>&1
