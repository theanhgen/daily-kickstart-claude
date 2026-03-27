#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"

ensure_project_dir
ensure_state_dir

FETCH_STATUS="skipped"
LOCK_MESSAGE="not needed"

if acquire_project_lock; then
    trap release_project_lock EXIT
    if run_with_timeout "$HEALTH_FETCH_TIMEOUT_SECONDS" git fetch "$REMOTE_NAME" "$BRANCH_NAME" > /dev/null 2>&1; then
        FETCH_STATUS="ok"
        LOCK_MESSAGE="lock acquired"
    else
        FETCH_STATUS="failed"
        LOCK_MESSAGE="lock acquired"
    fi
else
    LOCK_MESSAGE="another repo job is running"
fi

REMOTE_URL="$(git remote get-url "$REMOTE_NAME")"
HEAD_COMMIT="$(git rev-parse --short HEAD)"
HEAD_SUBJECT="$(git log -1 --format='%s' HEAD)"
set -- $(git_divergence_counts)
BEHIND_COUNT="${1:-0}"
AHEAD_COUNT="${2:-0}"
WORKTREE_STATUS="clean"

if tracked_changes_present; then
    WORKTREE_STATUS="dirty"
fi

LAST_HAIKU_TIMESTAMP="$(last_haiku_timestamp 2> /dev/null || echo unknown)"
if [ "$LAST_HAIKU_TIMESTAMP" = "unknown" ]; then
    LAST_HAIKU_AGE="unknown"
else
    LAST_HAIKU_AGE="$(( $(last_haiku_age_seconds) / 3600 ))h"
fi

LAST_RUN_TIMESTAMP="unknown"
LAST_RUN_STATUS="unknown"
LAST_RUN_CONTEXT="unknown"
LAST_RUN_MESSAGE="no runtime state recorded"
if [ -f "$STATUS_FILE" ]; then
    unset LAST_RUN_COMMIT
    load_status_file "$STATUS_FILE"
fi

LAST_HEALTH_TIMESTAMP="unknown"
LAST_HEALTH_STATUS="unknown"
LAST_HEALTH_SUMMARY="no health state recorded"
if [ -f "$HEALTH_STATE_FILE" ]; then
    load_status_file "$HEALTH_STATE_FILE"
fi

printf 'Project: %s\n' "$PROJECT_DIR"
printf 'Remote: %s\n' "$REMOTE_URL"
printf 'Head: %s %s\n' "$HEAD_COMMIT" "$HEAD_SUBJECT"
printf 'Fetch refresh: %s (%s)\n' "$FETCH_STATUS" "$LOCK_MESSAGE"
printf 'Divergence: behind=%s ahead=%s\n' "$BEHIND_COUNT" "$AHEAD_COUNT"
printf 'Tracked worktree: %s\n' "$WORKTREE_STATUS"
printf 'Last haiku: %s (%s)\n' "$LAST_HAIKU_TIMESTAMP" "$LAST_HAIKU_AGE"
printf 'Last run: %s [%s/%s]\n' "$LAST_RUN_TIMESTAMP" "$LAST_RUN_CONTEXT" "$LAST_RUN_STATUS"
printf 'Last run message: %s\n' "$LAST_RUN_MESSAGE"
printf 'Last healthcheck: %s [%s]\n' "$LAST_HEALTH_TIMESTAMP" "$LAST_HEALTH_STATUS"
printf 'Last health summary: %s\n' "$LAST_HEALTH_SUMMARY"

if [ -f kickstart.log ]; then
    printf '\nRecent kickstart log\n'
    printf -- '--------------------\n'
    tail -n 5 kickstart.log
fi

if [ -f healthcheck.log ]; then
    printf '\nRecent healthcheck log\n'
    printf -- '----------------------\n'
    tail -n 5 healthcheck.log
fi
