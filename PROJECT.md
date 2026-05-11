---
stage: maintaining
---

Automated haiku generator running on Raspberry Pi — generates and commits four haikus daily via the Claude API.

## Current
The top-level docs describe an operational Raspberry Pi setup that generates haikus four times daily, runs health checks, and pushes weekly commits automatically. Nothing in the README suggests active feature work; this reads like a maintenance runbook.

## Next
Run the Pi status check and confirm the last generation, sync, and healthcheck are all current.

## Milestone
**What:** Pi health verification
**Target:** 2026-05-31
- [ ] Verify last 7 days of haiku generation
- [ ] Check sync + push history
- [ ] Confirm cron is healthy
- [ ] Rotate logs if needed
