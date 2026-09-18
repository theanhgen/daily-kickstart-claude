---
stage: maintaining
---

Automated haiku generator running on Raspberry Pi — three engines (claude, codex, agy) each write a haiku four times daily; haikus are committed weekly and published to a GitHub Pages site.

## Current
Operational and in maintenance. Cron drives generation 4x/day across three engines, health checks every 30 min, weekly push, and CLI self-updates. Every push rebuilds the static site (today's haiku + archive with mood/sentiment trends, permalinks, OG cards). The codex model pin in `scripts/lib.sh` has moved twice as the ChatGPT account's model access shifted: gpt-5.5 (config default, 404s) -> gpt-5.4 (retired server-side 2026-09-04, cost ~5 days of codex haiku) -> `CODEX_MODEL=gpt-5.6-sol` today.

Side bench since 2026-09-17: on the Mac, `scripts/omniroute-haiku.py` asks every free OmniRoute model for a haiku 4x/day into a local SQLite db (not committed, not on the site). Run 1: 119 models, 42 ok, 5 malformed, 72 errors, mostly ids OmniRoute lists but its live catalog lacks. Enabling OmniRoute's model auto-sync briefly grew the roster to 555 (334 nous-research ids, only its three `:free` ones answer), fixed 2026-09-18 by classifying nous-research as free-tier in the multireview runner; the bench now also skips a model after three straight errors and retries it daily.

## Next
Keep the engines healthy: watch for CLI/model drift (the recurring failure mode) and confirm the daily site deploy succeeds.

## Milestone
**What:** Steady-state health verification
**Target:** 2026-07-31
- [ ] Verify last 7 days of generation across all three engines
- [ ] Confirm weekly push + Pages deploy are landing
- [ ] Confirm cron is healthy (no stale-haiku alerts)
- [ ] Confirm `update-clis.sh` is keeping codex/agy current
