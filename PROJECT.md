---
stage: maintaining
---

Automated haiku generator running on Raspberry Pi — three engines (claude, codex, agy) each write a haiku four times daily; haikus are committed weekly and published to a GitHub Pages site.

## Current
Operational and in maintenance. Cron drives generation 4x/day across three engines, health checks every 30 min, weekly push, and CLI self-updates. Every push rebuilds the static site (today's haiku + archive with mood/sentiment trends, permalinks, OG cards). The codex engine outage (account default migrated to gpt-5.5) was fixed by pinning `CODEX_MODEL=gpt-5.4` in `scripts/lib.sh`.

## Next
Keep the engines healthy: watch for CLI/model drift (the recurring failure mode) and confirm the daily site deploy succeeds.

## Milestone
**What:** Steady-state health verification
**Target:** 2026-07-31
- [ ] Verify last 7 days of generation across all three engines
- [ ] Confirm weekly push + Pages deploy are landing
- [ ] Confirm cron is healthy (no stale-haiku alerts)
- [ ] Confirm `update-clis.sh` is keeping codex/agy current
