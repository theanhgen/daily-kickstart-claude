---
stage: maintaining
---

Automated haiku generator running on Raspberry Pi — three engines (claude, codex, agy) each write a haiku four times daily; haikus are committed weekly and published to a GitHub Pages site.

## Current
Operational and in maintenance. Cron drives generation 4x/day across three engines, health checks every 30 min, weekly push, and CLI self-updates. Every push rebuilds the static site (today's haiku + archive with mood/sentiment trends, permalinks, OG cards). The codex model pin in `scripts/lib.sh` has moved twice as the ChatGPT account's model access shifted: gpt-5.5 (config default, 404s) -> gpt-5.4 (retired server-side 2026-09-04, cost ~5 days of codex haiku) -> `CODEX_MODEL=gpt-5.6-sol` today.

## Next
Keep the engines healthy: watch for CLI/model drift (the recurring failure mode) and confirm the daily site deploy succeeds.

## Milestone
**What:** Steady-state health verification
**Target:** 2026-07-31
- [ ] Verify last 7 days of generation across all three engines
- [ ] Confirm weekly push + Pages deploy are landing
- [ ] Confirm cron is healthy (no stale-haiku alerts)
- [ ] Confirm `update-clis.sh` is keeping codex/agy current
