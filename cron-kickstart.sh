#!/bin/bash
# Cron wrapper for kickstart
cd "$(dirname "$0")"
./kickstart-cli.sh >> kickstart.log 2>&1
