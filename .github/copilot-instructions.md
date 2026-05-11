# Copilot / AI agent instructions — Daily Kickstart Claude

Purpose: help an AI coding agent become productive quickly in this small automation repo.

- **Repo intent:** Runs on a Raspberry Pi. Cron triggers `kickstart-cli.sh` which calls the Claude CLI to generate a 3-line haiku, appends it to `haiku.txt`, then commits and pushes changes.

- **High-level flow:**
  - Cron -> `kickstart-cli.sh` (shell) -> local `claude` CLI -> write `haiku.txt` -> `git commit` -> `git pull --rebase origin main` -> `git push`.

- **Key files to read:** `README.md`, `session_prompt.txt`, `kickstart-cli.sh`, `cron-*.sh`, `haiku.txt`.

- **Important implementation details / assumptions**
  - Script uses strict shell flags: `set -euo pipefail` and a lock file (`/tmp/kickstart-claude.lock`) to prevent concurrent runs.
  - Claude CLI is invoked directly (path in `kickstart-cli.sh` is `/home/thevetev/.local/bin/claude`); prefer using configured environment or `PROJECT_DIR` when changing paths.
  - The script expects exactly (or mostly) 3 non-empty lines from Claude; it filters empty lines and takes the last 3.
  - Git workflow: commit local change, `git pull --rebase origin main` to avoid divergence, then push with retry logic.

- **Developer workflows (concrete commands)**
  - Manual test: `cd ~/daily-kickstart-claude && ./kickstart-cli.sh` (see `README.md` for full setup).
  - Update prompt: `echo "Your new prompt" > session_prompt.txt && git add session_prompt.txt && git commit -m "Update prompt" && git push`.
  - View logs: `tail -f ~/kickstart.log` and `tail -f ~/update.log`.

- **Patterns and conventions agents should follow when changing code**
  - Preserve `set -euo pipefail` and the lock-file semantics when editing shells.
  - Keep text output deterministic for `claude` (script uses an explicit `--system-prompt`); changes that alter output shape should update the parsing/validation code.
  - Respect the `PROJECT_DIR` env var override and defaults hard-coded in scripts.
  - When changing git behavior, follow the existing rebase-first approach to reduce merge conflicts.

- **Integration and external dependencies**
  - Relies on a locally-installed Claude CLI (installed via `npm` per `README.md`), Git, and cron on the Pi.
  - The cron jobs in `README.md` describe scheduled runs and auxiliary scripts (`cron-update.sh`, `cron-weekly-push.sh`).

- **What to avoid / known pitfalls**
  - Do not assume `claude` binary is on `$PATH` — the script uses an absolute path. If you change this, update README and cron entries.
  - Avoid changing the log/haiku file format — downstream consumers (humans or scripts) expect timestamp line followed by three lines.
  - Be careful with `git push` changes: cron-run environment may have stored credentials via `git credential.helper store` (see README); do not convert to interactive auth.

- **Quick examples the agent can use when proposing edits**
  - Keep file-safe temp usage: `HAIKU_OUTPUT=$(mktemp)` and `grep -v "^$" "$HAIKU_OUTPUT" | tail -3` for extraction.
  - Preserve commit message style: `git commit -m "Daily haiku - $TIMESTAMP"`.

- **If tests or CI are requested**
  - This repo has no test suite; verify changes by running `./kickstart-cli.sh` locally (simulate cron) and by checking `haiku.txt` and `kickstart.log`.

If any of these environment details are out-of-date (paths, cron locations, or the `claude` install method), ask the maintainer before making changes. Request any missing environment variables or credentials needed to run the script locally.

---
Please review these instructions and tell me which areas need more detail (examples, exact file links, or environment specifics).
