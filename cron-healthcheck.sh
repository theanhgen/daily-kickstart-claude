#!/bin/bash
# Cron wrapper for health checks
cd "$(dirname "$0")"
./healthcheck.sh >> healthcheck.log 2>&1
