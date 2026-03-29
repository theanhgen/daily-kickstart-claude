#!/bin/bash
# Weekly commit and push for accumulated haikus
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
. scripts/lib.sh

MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_DELAY="${RETRY_DELAY:-5}"

ensure_project_dir
ensure_state_dir
load_notify_config

finish() {
    local exit_code="$1"
    local status="$2"
    local message="$3"

    write_status "$status" "weekly-commit" "$message"
    log "$message"
    if [ "$exit_code" -ne 0 ]; then
        scripts/notify.sh error "$PROJECT_NAME weekly-push failed" "$message" || true
    fi
    exit "$exit_code"
}

if ! acquire_project_lock; then
    finish 1 "lock_unavailable" "ERROR: Another repo job is already running"
fi
trap release_project_lock EXIT

# Stash uncommitted haiku changes before syncing
STASHED=0
if ! git diff --quiet -- haiku.txt 2>/dev/null; then
    git stash push -q -m "weekly-pre-sync" -- haiku.txt
    STASHED=1
fi

# Fetch and rebase to stay current
log "Fetching latest changes..."
if ! run_with_timeout "$FETCH_TIMEOUT_SECONDS" git fetch "$REMOTE_NAME" "$BRANCH_NAME" > /dev/null 2>&1; then
    if [ "$STASHED" -eq 1 ]; then git stash pop -q 2>/dev/null || true; fi
    finish 1 "fetch_failed" "ERROR: Git fetch failed"
fi

if ! git rebase "$REMOTE_NAME/$BRANCH_NAME" > /dev/null 2>&1; then
    git rebase --abort > /dev/null 2>&1 || true
    if [ "$STASHED" -eq 1 ]; then git stash pop -q 2>/dev/null || true; fi
    finish 1 "rebase_failed" "ERROR: Git rebase failed, manual intervention needed"
fi

# Restore stashed haiku changes
if [ "$STASHED" -eq 1 ]; then
    git stash pop -q 2>/dev/null || true
fi

# Check if haiku.txt has uncommitted changes
if git diff --quiet -- haiku.txt 2>/dev/null; then
    finish 0 "noop" "No new haikus to commit"
fi

# Extract date range from new entries
FIRST_NEW=$(git diff -- haiku.txt | grep -oP '^\+\K[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)
LAST_NEW=$(git diff -- haiku.txt | grep -oP '^\+\K[0-9]{4}-[0-9]{2}-[0-9]{2}' | tail -1)
NEW_COUNT=$(git diff -- haiku.txt | grep -cP '^\+[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)

if [ -n "$FIRST_NEW" ] && [ -n "$LAST_NEW" ]; then
    COMMIT_MSG="Weekly haiku: $FIRST_NEW to $LAST_NEW ($NEW_COUNT new)"
else
    COMMIT_MSG="Weekly haiku batch ($(date -u '+%Y-%m-%d'))"
fi

git add haiku.txt
if ! git commit -m "$COMMIT_MSG" > /dev/null 2>&1; then
    finish 0 "noop" "Nothing to commit after staging"
fi

log "Committed: $COMMIT_MSG"

# Push with retry logic
log "Pushing to GitHub..."
for attempt in $(seq 1 $MAX_RETRIES); do
    if run_with_timeout "$PUSH_TIMEOUT_SECONDS" git push "$REMOTE_NAME" "$BRANCH_NAME" > /dev/null 2>&1; then
        finish 0 "success" "Successfully pushed: $COMMIT_MSG"
    else
        if [ $attempt -lt $MAX_RETRIES ]; then
            log "Push failed (attempt $attempt/$MAX_RETRIES), retrying in ${RETRY_DELAY}s..."
            sleep $RETRY_DELAY
        else
            finish 1 "push_failed" "ERROR: Git push failed after $MAX_RETRIES attempts; commit kept locally"
        fi
    fi
done
