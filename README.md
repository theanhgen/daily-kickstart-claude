# Daily Kickstart Claude

A Raspberry Pi that writes haikus. Four times a day, every day, powered by Claude.

```
Still pond reflects sky
A frog leaps into silence
Ripples carry light
```

## How it works

Cron wakes Claude CLI four times daily. Claude writes a haiku. The script appends it to `haiku.txt`. On Sundays, everything gets committed and pushed. That's it.

## Quick start

```bash
# Prerequisites: Raspberry Pi, Node.js, Claude CLI, git
npm install -g @anthropic-ai/claude-code
claude auth login

# Clone and test
git clone git@github.com:theanhgen/daily-kickstart-claude.git
cd daily-kickstart-claude
chmod +x scripts/*.sh cron/*.sh
scripts/generate.sh
cat haiku.txt
```

## Automate it

```bash
crontab -e
```

```cron
# Haiku generation — 4x daily
0 6,12,18,22 * * * /home/YOUR_USER/daily-kickstart-claude/cron/generate.sh

# Weekly commit + push (Sunday 23:00)
0 23 * * 0 /home/YOUR_USER/daily-kickstart-claude/cron/weekly-push.sh

# Health checks every 30 min
15,45 * * * * /home/YOUR_USER/daily-kickstart-claude/cron/healthcheck.sh

# Daily sync fallback
21 21 * * * /home/YOUR_USER/daily-kickstart-claude/cron/sync.sh

# Log rotation every 3 days
0 0 */3 * * /home/YOUR_USER/daily-kickstart-claude/cron/rotate-logs.sh
```

## Project structure

```
scripts/
  generate.sh           Generates a haiku and appends to haiku.txt
  lib.sh                Shared config, locking, and utilities
  healthcheck.sh        Monitors freshness and sync state
  status.sh             Quick operator dashboard
  sync.sh               Fetch, rebase, push (no generation)
  notify.sh             Optional ntfy notifications
  session_prompt.txt    The prompt — change this to change the output
  .notify.env.example   Notification config template

cron/                   Thin wrappers that log output and call scripts/

haiku.txt               The ever-growing archive
```

## Customize

Change what Claude writes:
```bash
echo "Write a two-line koan." > scripts/session_prompt.txt
```

Change the schedule: `crontab -e`

Enable notifications:
```bash
cp scripts/.notify.env.example .notify.env
# edit .notify.env with your ntfy topic
```

## Operator commands

```bash
scripts/generate.sh      # Generate a haiku now
scripts/status.sh        # Dashboard: sync state, last run, recent logs
scripts/healthcheck.sh   # Check health
scripts/sync.sh          # Push pending commits
tail -f kickstart.log    # Watch generation logs
```

## License

Public domain. See [LICENSE](LICENSE).
