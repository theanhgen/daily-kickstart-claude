#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"

ensure_project_dir
ensure_state_dir

finish() {
    local exit_code="$1"
    local status="$2"
    local message="$3"

    write_status "$status" "sync-now" "$message"
    log "$message"
    exit "$exit_code"
}

if ! acquire_project_lock; then
    finish 1 "sync_lock_unavailable" "ERROR: Another repo job is already running"
fi
trap release_project_lock EXIT

# Only the automation outputs may be dirty here. Anything else means a human
# is mid-edit (or something unexpected wrote to the tree) — refuse rather than
# let --autostash carry unrelated changes across an unattended rebase.
# Exclude the two outputs with pathspecs (as cron/weekly-push.sh does) rather
# than by grepping the porcelain output: a regex over those lines also swallows
# lookalike paths (notes/my_haiku.txt, test_model.log) and rename lines ending
# in the same names, so a human's mid-edit would slip through the gate.
# A failing git status (corrupt .git, dubious ownership) must not abort under
# `set -e` before finish() writes a status — healthcheck would then read the
# previous run's stale LAST_RUN_STATUS and report healthy.
if ! FOREIGN_DIRTY="$(git status --porcelain --untracked-files=no -- ':(exclude)haiku.txt' ':(exclude)model.log')"; then
    finish 1 "sync_status_failed" "ERROR: git status failed, cannot verify the worktree is clean"
fi
if [ -n "$FOREIGN_DIRTY" ]; then
    finish 1 "sync_foreign_changes" "ERROR: Tracked changes beyond haiku.txt/model.log present, refusing to sync"
fi

log "Fetching latest changes..."
if ! retry "$FETCH_RETRY_COUNT" "$FETCH_RETRY_DELAY_SECONDS" run_with_timeout "$FETCH_TIMEOUT_SECONDS" git fetch "$REMOTE_NAME" "$BRANCH_NAME" > /dev/null 2>&1; then
    finish 1 "sync_fetch_failed" "ERROR: Git fetch failed after $FETCH_RETRY_COUNT attempts"
fi

# Uncommitted haiku.txt/model.log appends are the normal mid-week state;
# --autostash carries them across the rebase instead of refusing to sync.
if ! git rebase --autostash "$REMOTE_NAME/$BRANCH_NAME" > /dev/null 2>&1; then
    git rebase --abort > /dev/null 2>&1 || true
    finish 1 "sync_rebase_failed" "ERROR: Git rebase failed, manual intervention needed"
fi

# A conflicting autostash re-application leaves markers in the worktree yet
# the rebase still exits 0. Never let that state stand: restore a clean tree
# (the appends survive in the autostash entry) and alert.
if unmerged_paths_present; then
    git reset --hard HEAD > /dev/null 2>&1 || true
    finish 1 "sync_autostash_conflict" "ERROR: Autostash conflict during rebase; appends kept in git stash, run 'git stash pop' manually"
fi

set -- $(git_divergence_counts)
BEHIND_COUNT="${1:-0}"
AHEAD_COUNT="${2:-0}"

if [ "$BEHIND_COUNT" -ne 0 ]; then
    finish 1 "sync_diverged" "ERROR: Repository is still behind after rebase"
fi

if [ "$AHEAD_COUNT" -eq 0 ]; then
    finish 0 "sync_clean" "Repository already synchronized with origin/main"
fi

log "Pushing $AHEAD_COUNT local commit(s) to GitHub..."
if ! run_with_timeout "$PUSH_TIMEOUT_SECONDS" git push "$REMOTE_NAME" "$BRANCH_NAME" > /dev/null 2>&1; then
    finish 1 "sync_push_failed" "ERROR: Git push failed"
fi

finish 0 "sync_success" "Successfully pushed $AHEAD_COUNT local commit(s) to GitHub"
