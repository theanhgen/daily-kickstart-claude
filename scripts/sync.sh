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

if tracked_changes_present; then
    finish 1 "sync_tracked_changes" "ERROR: Tracked working tree changes present, refusing to sync"
fi

log "Fetching latest changes..."
if ! run_with_timeout "$FETCH_TIMEOUT_SECONDS" git fetch "$REMOTE_NAME" "$BRANCH_NAME" > /dev/null 2>&1; then
    finish 1 "sync_fetch_failed" "ERROR: Git fetch failed"
fi

if ! git rebase "$REMOTE_NAME/$BRANCH_NAME" > /dev/null 2>&1; then
    git rebase --abort > /dev/null 2>&1 || true
    finish 1 "sync_rebase_failed" "ERROR: Git rebase failed, manual intervention needed"
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
