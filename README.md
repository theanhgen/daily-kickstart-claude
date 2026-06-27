# Daily Kickstart Claude

```
   .-=-=-=-.
  ( DAILY    )   A Raspberry Pi sits on a shelf and writes poetry.
  ( KICKSTART)   Four times a day. Every day. Forever.
   `-=-=-=-'      No muse required.
```

A tiny computer, a fistful of cron jobs, and three robots arguing about syllables. That's the whole show.

```
Still pond reflects sky
A frog leaps into silence
Ripples carry light
```

## The premise

Somewhere on a Raspberry Pi, the clock ticks over to 06:00. Cron yawns, stretches, and pokes three AI CLIs awake — `claude`, `codex`, and `agy`. Each one squints at the morning and coughs up a haiku. The script catches them, stamps each with its author, and files them into `haiku.txt`. Come Sunday night, the whole week's worth gets committed and pushed while you sleep. Then it does it all again. Forever. That's it. That's the app.

No server. No dashboard. No "please rate your experience." Just a small machine quietly being a poet.

## Grab it and go

```bash
# You'll need: a Raspberry Pi (or any Linux box), Node.js, the Claude CLI, and git
npm install -g @anthropic-ai/claude-code
claude auth login

# Clone, make the scripts executable, kick the tires
git clone git@github.com:theanhgen/daily-kickstart-claude.git
cd daily-kickstart-claude
chmod +x scripts/*.sh cron/*.sh
scripts/generate.sh
cat haiku.txt          # behold: a poem, fresh from the silicon
```

## Put it on autopilot

Hand the keys to cron and walk away:

```bash
crontab -e
```

```cron
# Lock to Czech local time, because daylight saving is chaos
CRON_TZ=Europe/Prague

# The main event — poetry, 4x daily
0 6,12,16,22 * * * /home/YOUR_USER/daily-kickstart-claude/cron/generate.sh

# Sunday-night ritual: commit + push the week's verses (23:00)
0 23 * * 0 /home/YOUR_USER/daily-kickstart-claude/cron/weekly-push.sh

# Vital-signs check, every half hour
15,45 * * * * /home/YOUR_USER/daily-kickstart-claude/cron/healthcheck.sh

# Just-in-case daily sync
21 21 * * * /home/YOUR_USER/daily-kickstart-claude/cron/sync.sh

# Sweep the logs every 3 days
0 0 */3 * * /home/YOUR_USER/daily-kickstart-claude/cron/rotate-logs.sh

# Keep the engine CLIs current (before the first cycle) — a stale CLI can
# silently drop an engine when a provider ships a new default model
0 5 * * * /home/YOUR_USER/daily-kickstart-claude/cron/update-clis.sh
```

If a provider's default model outruns its CLI (it happens), pin a working one
without touching code — e.g. `CODEX_MODEL=gpt-5.1`. A failed engine is isolated:
the others still run, and the alert says whether it needs an upgrade or a pin.

## Meet the poets

Every cycle, three CLIs take the mic in order. Each haiku gets tagged with whoever wrote it, so the archive reads like a robot open-mic night.

```
  claude  ──▶  the house regular (default)
  codex   ──▶  the wildcard
  agy      ──▶  Google Antigravity, the new kid (runs last, needs a one-time login)
```

Want just one? Summon it by name:

```bash
ENGINE=agy scripts/generate.sh     # claude (default) | codex | agy
```

First time with `agy`, log it in once (`agy -p test`). Swapping binaries or tweaking timeouts? Everything lives in `scripts/lib.sh` — `AGY_BIN`, `AGY_TIMEOUT_SECONDS`, and friends.

## What's in the box

```
scripts/
  generate.sh           Writes one haiku, appends to haiku.txt
  lib.sh                Shared config, locking, the boring-but-load-bearing bits
  healthcheck.sh        "Is the poet still breathing?"
  status.sh             Operator dashboard at a glance
  sync.sh               Fetch, rebase, push — no poetry involved
  notify.sh             Optional ntfy pings
  session_prompt.txt    The muse. Edit this, change the soul.
  .notify.env.example   Notification config template

cron/                   Thin wrappers that log everything and call scripts/

haiku.txt               The ever-growing book of verses
```

## Make it yours

Rewrite the muse:
```bash
echo "Write a two-line koan." > scripts/session_prompt.txt
```

Change when the magic happens: `crontab -e`

Get pinged when a haiku lands (or when something breaks):
```bash
cp scripts/.notify.env.example .notify.env
# drop your ntfy topic in .notify.env
```

## Pulling the levers

```bash
scripts/generate.sh      # Make a haiku, right now, on demand
scripts/status.sh        # Dashboard: sync state, last run, recent logs
scripts/healthcheck.sh   # Take the patient's pulse
scripts/sync.sh          # Push whatever's pending
tail -f kickstart.log    # Watch the poems roll in, live
```

## License

Public domain. Take it, fork it, teach your own toaster to write sonnets. See [LICENSE](LICENSE).
