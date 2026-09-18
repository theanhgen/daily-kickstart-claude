# Daily Kickstart Claude

```
   .-=-=-=-.
  ( DAILY    )   A small machine on a shelf,
  ( KICKSTART)   writing poems while the world sleeps.
   `-=-=-=-'      Four times a day. No muse required.
```

One small computer.
A handful of cron jobs.
Three engines, taking turns at the syllables.

**Read them here → <https://theanhgen.github.io/daily-kickstart-claude/>**

```
Still pond reflects sky
A frog leaps into silence
Ripples carry light
```

## How it wakes

The clock turns to 06:00.

Cron stirs and wakes three CLIs — `claude`, `codex`, `agy`. Each looks at the morning and offers a haiku. The script gathers them, marks each with its author, and lays them down in `haiku.txt`.

On Sunday night, the week's verses are committed and pushed while you sleep.

Then the pond goes still, and waits for six o'clock.

No hand at the wheel. Just a quiet machine, keeping a poet's hours — and a small website out front, holding up the verses to the light.

## The verses, online

Every push wakes a GitHub Actions job that rebuilds a static site and carries it to GitHub Pages — no server to tend, only files. [scripts/build-site.py](scripts/build-site.py) reads `haiku.txt` and renders:

- **Today's haiku** on the front page, in the writing engine's colour.
- **An archive** of every haiku ever written, gathered by daily cycle, each marked with its author and a mood score.
- **Sentiment trends** — per-engine mood over the last 90 days, so you can watch the machines' weather drift.
- **Shareable permalinks** — every haiku keeps its own page (`/h/<slug>/`) with Open Graph / Twitter meta and a 1200×630 card, so a link unfolds into the poem.

Live at **<https://theanhgen.github.io/daily-kickstart-claude/>**. The build lives in [.github/workflows/deploy.yml](.github/workflows/deploy.yml); preview cards are cached between deploys, so only new haikus are drawn again.

## Begin

```bash
# You'll need: a Raspberry Pi (or any Linux box), Node.js, the Claude CLI, and git
npm install -g @anthropic-ai/claude-code
claude auth login

# Clone, make the scripts executable, kick the tires
git clone git@github.com:theanhgen/daily-kickstart-claude.git
cd daily-kickstart-claude
chmod +x scripts/*.sh cron/*.sh
scripts/generate.sh
cat haiku.txt          # a poem, fresh from the silicon
```

## Let it run

Hand the hours to cron and step away:

```bash
crontab -e
```

```cron
# Lock to Czech local time, because daylight saving is chaos
CRON_TZ=Europe/Prague

# The main event — poetry, 4x daily
0 6,11,16,21 * * * /home/YOUR_USER/daily-kickstart-claude/cron/generate.sh

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
without touching code — e.g. `CODEX_MODEL=gpt-5.6-sol`. A failed engine is isolated:
the others still run, and the alert says whether it needs an upgrade or a pin.

## The three voices

Each cycle, three CLIs take the mic in turn. Every haiku is signed by whoever wrote it, so the archive reads like a quiet round of voices.

```
  claude  ──▶  the house regular (default)
  codex   ──▶  the wildcard
  agy      ──▶  Google Antigravity, the new arrival (runs last, needs a one-time login)
```

Want just one voice? Call it by name:

```bash
ENGINE=agy scripts/generate.sh     # claude (default) | codex | agy
```

First time with `agy`, log it in once (`agy -p test`). Swapping binaries, pinning models, or tuning timeouts? It all lives in [scripts/lib.sh](scripts/lib.sh) — `AGY_BIN`, `AGY_MODEL`, `AGY_MODEL_FALLBACKS`, `CODEX_MODEL`, `AGY_TIMEOUT_SECONDS`, and friends. If the agy default model fails, cron retries once with a randomly selected model from `AGY_MODEL_FALLBACKS`. Each generation also notes which model actually answered, in `model.log` (committed, never rotated), so the site's mood trends stay tied to the models behind them. `claude` and `codex` each name the model they used, and that name is what gets written down — so when a provider quietly rolls its default under an unpinned run (`gpt-5.4` → `gpt-5.5`, say), the swap surfaces as a dashed marker on the trend chart. `agy` doesn't say, so its default runs read `unknown`; explicit fallback runs record their selected model. Since 2026-09-18 each line also carries the reasoning effort (`effort=`): `codex` reads it from the same banner (`low` today), `claude` records `default` because no `--effort` is passed, and `agy` records what a pinned id names (`gpt-oss-120b-medium` → `medium`), else `unknown`. An effort change marks the chart the same way a model swap does.

## The free-model bench

Off to one side, a fourth voice that stays off the front page. On the Mac that hosts
OmniRoute (the local model router), `scripts/omniroute-haiku.py` asks **every free model
OmniRoute can reach at that moment** for a haiku, at the same four times, and files each
answer in a local SQLite database, `omniroute-haiku.db` (gitignored, never pushed). Nothing
touches `haiku.txt`, `model.log`, the archive or its stats. A daily export feeds its own page,
**[Experimental](https://theanhgen.github.io/daily-kickstart-claude/experimental.html)**,
linked under Archive.

- **Which models:** the multireview runner's `roster` subcommand decides what counts as free,
  so there is one cost table, not two. Around 120 models across 15 providers today.
- **What's kept:** every attempt, failures included, so the database also shows what was
  available when. Each row records the model asked for, its OmniRoute provider, the provider
  and model that actually answered (`x-omniroute-provider` / `x-omniroute-model`), status,
  latency, tokens, and OmniRoute's request id. Effort is the reasoning level the id names
  (`gemini-3.7-flash-high` → `high`), `default` when it names none.
- **Dead models are skipped:** one whose last three attempts all errored is left out of the
  next runs and retried once a day. Most of the roster is ids OmniRoute lists but can't serve,
  so this roughly halves the calls.
- **Runs from the Mac's crontab**, calling Homebrew's `python3` directly: macOS blocks
  `bash` and launchd jobs from this repo under `~/Desktop`. The log is
  `~/Library/Logs/omniroute-haiku.log`. Failures stay in the log and never reach ntfy.

- **Published daily** by `omniroute-haiku.py publish`. It exports the latest run's haikus plus
  14 days of per-model answered/asked counts (no errors, raw replies or request ids). The export
  is force-pushed as the only file on the `bench-data` branch, from a bare repo in
  `~/Library/Caches`, so the working copy is never touched. Then it starts the Pages deploy on
  `main` with `gh workflow run`, because the `github-pages` environment only deploys `main`.
  The deploy copies the file in; before the first publish the page shows an empty state.
  `omniroute-haiku.py export site/free-models.json` writes the same file locally for a preview.

```cron
0 6,11,16,21 * * * PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/python3 /path/to/daily-kickstart-claude/scripts/omniroute-haiku.py >> ~/Library/Logs/omniroute-haiku.log 2>&1
30 21 * * * PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/python3 /path/to/daily-kickstart-claude/scripts/omniroute-haiku.py publish >> ~/Library/Logs/omniroute-haiku.log 2>&1
```

```bash
sqlite3 omniroute-haiku.db "select model, served_provider, haiku from attempts where status = 'ok' order by id desc limit 10"
```

## What lives here

```
scripts/
  generate.sh           Writes one haiku with the chosen ENGINE, appends to haiku.txt
  lib.sh                Shared config, locking, the boring-but-load-bearing bits
  build-site.py         Renders haiku.txt → site/ (json, permalinks, preview cards)
  omniroute-haiku.py    Free-model bench: every free OmniRoute model → omniroute-haiku.db (Mac only)
  healthcheck.sh        "Is the poet still breathing?"
  status.sh             Operator dashboard at a glance
  sync.sh               Fetch, rebase, push — no poetry involved
  notify.sh             Optional ntfy pings
  session_prompt.txt    The muse. Edit this, change the soul.

cron/                   Thin wrappers that log everything and call scripts/
  generate.sh             Runs all three engines, one cycle
  weekly-push.sh          Sunday-night commit + push of the week's verses
  healthcheck.sh          Periodic vital-signs check
  sync.sh                 Daily fetch/rebase/push safety net
  rotate-logs.sh          Keeps the *.log files from growing forever
  update-clis.sh          Self-updates the engine CLIs ahead of the day's first run

site/                   The static site (index, archive, main.js, style.css, fonts,
                        favicons; experimental.html + .js for the free-model bench).
                        haiku.json, h/ and free-models.json are build artifacts, not committed.
.github/workflows/      deploy.yml — builds site/ and publishes to GitHub Pages on push
tests/
  run.sh                  Stubbed unit tests for generate.sh, lib.sh, and sync.sh's safety gate
  test_build_site.py      Parsing, the Atom feed, and model-change detection
  test_omniroute_haiku.py The free-model bench, against a stub OmniRoute
  test_main.js            Front-end helpers — syllables, mood, trend copy
  test_experimental.js    The experimental page's rendering and escaping
haiku.txt               The ever-growing book of verses
model.log               Which model wrote each haiku (committed, never rotated)
.notify.env.example     Notification config template
```

## Make it yours

Rewrite the muse:
```bash
echo "Write a two-line koan." > scripts/session_prompt.txt
```

Change when the magic happens: `crontab -e`

Get pinged when something breaks (or recovers):
```bash
cp .notify.env.example .notify.env
# drop your ntfy topic in .notify.env
```

## The controls

```bash
scripts/generate.sh      # Make a haiku, right now, on demand
scripts/status.sh        # Dashboard: sync state, last run, recent logs
scripts/healthcheck.sh   # Take the patient's pulse
scripts/sync.sh          # Push whatever's pending
scripts/build-site.py    # Rebuild the site locally (needs Python; Pillow for cards)
tests/run.sh             # Run the unit tests
tail -f kickstart.log    # Watch the poems roll in, live
```

One footnote on `build-site.py`: it injects fresh Open Graph meta into `site/index.html`,
which *is* tracked — so a local run leaves that file modified. Harmless, but run
`git checkout -- site/index.html` before you commit, or the day's stats ride along in your
diff. On the machine running the cron jobs, don't run it at all: `sync.sh` refuses to sync a
tree carrying unexpected tracked changes, so a stray rebuild quietly jams the daily pull until
someone notices. The site is GitHub's job.

## License

Public domain. Take it, fork it, teach your own toaster to write sonnets. See [LICENSE](LICENSE).
