---
stage: maintaining
---

Automated haiku generator running on Raspberry Pi — three engines (claude, codex, agy) each write a haiku four times daily; haikus are committed weekly and published to a GitHub Pages site.

## Current
Operational and in maintenance. Cron drives generation 4x/day across three engines, health checks every 30 min, weekly push, and CLI self-updates. Every push rebuilds the static site (today's haiku + archive with mood/sentiment trends, permalinks, OG cards). The codex model pin in `scripts/lib.sh` has moved twice as the ChatGPT account's model access shifted: gpt-5.5 (config default, 404s) -> gpt-5.4 (retired server-side 2026-09-04, cost ~5 days of codex haiku) -> `CODEX_MODEL=gpt-5.6-sol` today. Since 2026-09-23 a rejected pin falls back through `CODEX_FALLBACK_MODELS` (default: the CLI's own default) and sends one warning, instead of losing codex haiku until someone notices.

Side bench since 2026-09-17: on the Mac, `scripts/omniroute-haiku.py` asks every free OmniRoute model for a haiku 4x/day into a local SQLite db (not committed, not on the site). Run 1: 119 models, 42 ok, 5 malformed, 72 errors, mostly ids OmniRoute lists but its live catalog lacks. Enabling OmniRoute's model auto-sync briefly grew the roster to 555 (334 nous-research ids, only its three `:free` ones answer), fixed 2026-09-18 by classifying nous-research as free-tier in the multireview runner; the bench now also skips a model after three straight errors and retries it daily. Since 2026-09-18 it is public on the site's Experimental page (daily publish to the `bench-data` branch + `gh workflow run` deploy), and model.log records each engine's reasoning effort.

## Next
Keep the engines healthy: watch for CLI/model drift (the recurring failure mode) and confirm the daily site deploy succeeds.

## Milestone
**What:** Steady-state health verification
**Target:** 2026-07-31
- [x] Verify last 7 days of generation across all three engines — checked 2026-09-23 against `model.log` through the 2026-09-20 push: claude and codex 4/day (3 on 09-18); agy 4/day since 09-15, after an outage 09-11 to 09-14 (2, 1, 0, 0) that PR #38 fixed.
- [x] Confirm weekly push + Pages deploy are landing — checked 2026-09-23: weekly pushes every Sunday since 2026-08-02; daily bench deploys green 09-18 to 09-23. The one red main run (09-19, `site/haiku.json` missing in the JS tests) was fixed by 4632c01.
- [ ] Confirm cron is healthy (no stale-haiku alerts) — not checked: needs the Pi's `kickstart.log` / ntfy history. Generation continuity above is indirect evidence only.
- [ ] Confirm `update-clis.sh` is keeping codex/agy current — not checked: needs the Pi's `update.log`.
