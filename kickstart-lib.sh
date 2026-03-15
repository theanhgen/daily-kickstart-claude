#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT_DIR="${PROJECT_DIR:-$SCRIPT_DIR}"
PROJECT_NAME="${PROJECT_NAME:-daily-kickstart-claude}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH_NAME="${BRANCH_NAME:-main}"
LOCK_FILE="${LOCK_FILE:-/tmp/kickstart-claude.lock}"
STATE_DIR="${STATE_DIR:-$PROJECT_DIR/.runtime}"
STATUS_FILE="${STATUS_FILE:-$STATE_DIR/last_run.env}"
HEALTH_STATE_FILE="${HEALTH_STATE_FILE:-$STATE_DIR/healthcheck.env}"
CLAUDE_BIN="${CLAUDE_BIN:-/home/thevetev/.local/bin/claude}"
FETCH_TIMEOUT_SECONDS="${FETCH_TIMEOUT_SECONDS:-30}"
CLAUDE_TIMEOUT_SECONDS="${CLAUDE_TIMEOUT_SECONDS:-180}"
PUSH_TIMEOUT_SECONDS="${PUSH_TIMEOUT_SECONDS:-60}"
HEALTH_FETCH_TIMEOUT_SECONDS="${HEALTH_FETCH_TIMEOUT_SECONDS:-30}"
HEALTH_MAX_HAIKU_AGE_HOURS="${HEALTH_MAX_HAIKU_AGE_HOURS:-18}"
NOTIFY_CONFIG_FILE="${NOTIFY_CONFIG_FILE:-$PROJECT_DIR/.notify.env}"

LOCK_BACKEND=""
LOCK_FD=""

timestamp_utc() {
    date -u '+%Y-%m-%d %H:%M:%S UTC'
}

log() {
    echo "[$(timestamp_utc)] $*"
}

ensure_project_dir() {
    cd "$PROJECT_DIR"
}

ensure_state_dir() {
    mkdir -p "$STATE_DIR"
}

load_notify_config() {
    if [ -f "$NOTIFY_CONFIG_FILE" ]; then
        # shellcheck source=/dev/null
        . "$NOTIFY_CONFIG_FILE"
    fi
}

run_with_timeout() {
    local seconds="$1"
    shift

    if command -v timeout > /dev/null 2>&1; then
        timeout --foreground "${seconds}s" "$@"
    else
        "$@"
    fi
}

acquire_project_lock() {
    if command -v flock > /dev/null 2>&1; then
        exec {LOCK_FD}>"$LOCK_FILE"
        if ! flock -n "$LOCK_FD"; then
            LOCK_FD=""
            return 1
        fi
        LOCK_BACKEND="flock"
        return 0
    fi

    if ( set -o noclobber; : > "$LOCK_FILE" ) 2> /dev/null; then
        LOCK_BACKEND="file"
        return 0
    fi

    return 1
}

release_project_lock() {
    case "$LOCK_BACKEND" in
        flock)
            if [ -n "$LOCK_FD" ]; then
                eval "exec ${LOCK_FD}>&-"
            fi
            ;;
        file)
            rm -f "$LOCK_FILE"
            ;;
    esac

    LOCK_BACKEND=""
    LOCK_FD=""
}

tracked_changes_present() {
    [ -n "$(git status --porcelain --untracked-files=no)" ]
}

write_status() {
    local status="$1"
    local context="$2"
    local message="$3"
    local commit_ref="unknown"

    ensure_state_dir

    if git rev-parse --verify HEAD > /dev/null 2>&1; then
        commit_ref="$(git rev-parse --short HEAD)"
    fi

    {
        printf 'LAST_RUN_TIMESTAMP=%q\n' "$(timestamp_utc)"
        printf 'LAST_RUN_STATUS=%q\n' "$status"
        printf 'LAST_RUN_CONTEXT=%q\n' "$context"
        printf 'LAST_RUN_MESSAGE=%q\n' "$message"
        printf 'LAST_RUN_COMMIT=%q\n' "$commit_ref"
    } > "$STATUS_FILE"
}

write_health_state() {
    local status="$1"
    local summary="$2"

    ensure_state_dir

    {
        printf 'LAST_HEALTH_TIMESTAMP=%q\n' "$(timestamp_utc)"
        printf 'LAST_HEALTH_STATUS=%q\n' "$status"
        printf 'LAST_HEALTH_SUMMARY=%q\n' "$summary"
    } > "$HEALTH_STATE_FILE"
}

load_status_file() {
    if [ -f "$1" ]; then
        # shellcheck source=/dev/null
        . "$1"
    fi
}

last_haiku_timestamp() {
    grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC$' haiku.txt | tail -1
}

last_haiku_age_seconds() {
    local last_timestamp
    local last_epoch
    local now_epoch

    last_timestamp="$(last_haiku_timestamp)"
    last_epoch="$(date -u -d "$last_timestamp" +%s)"
    now_epoch="$(date -u +%s)"

    echo $((now_epoch - last_epoch))
}

git_divergence_counts() {
    git rev-list --left-right --count "$REMOTE_NAME/$BRANCH_NAME"...HEAD
}
