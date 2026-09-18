#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT_DIR="${PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PROJECT_NAME="${PROJECT_NAME:-daily-kickstart-claude}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH_NAME="${BRANCH_NAME:-main}"
LOCK_FILE="${LOCK_FILE:-/tmp/kickstart-claude.lock}"
STATE_DIR="${STATE_DIR:-$PROJECT_DIR/.runtime}"
STATUS_FILE="${STATUS_FILE:-$STATE_DIR/last_run.env}"
HEALTH_STATE_FILE="${HEALTH_STATE_FILE:-$STATE_DIR/healthcheck.env}"
CLAUDE_BIN="${CLAUDE_BIN:-/home/thevetev/.local/bin/claude}"
# Use the npm-global codex (the user-managed copy that self-updates), not the
# stale root /usr/bin/codex which is pinned old and can't update without a TTY.
CODEX_BIN="${CODEX_BIN:-/home/thevetev/.npm-global/bin/codex}"
AGY_BIN="${AGY_BIN:-/home/thevetev/.local/bin/agy}"
# Primary agy model (empty = agy's own default, currently gemini-3.8-flash).
# Override via env to pin a specific model id (see: agy models).
AGY_MODEL="${AGY_MODEL:-}"
# Fallback model chain tried in order when the primary model returns a quota /
# availability error. Claude and GPT-OSS cover the case where Gemini quota is
# exhausted. Set to "" to disable fallback entirely.
AGY_FALLBACK_MODELS="${AGY_FALLBACK_MODELS:-claude-sonnet-4-6 gpt-oss-120b-medium}"
# Pin codex to a model the account actually has. This has moved twice: the
# config default rolled to gpt-5.5 (which 404s for this ChatGPT account), and
# the old gpt-5.4 pin was retired server-side on 2026-09-04 ("not supported
# when using Codex with a ChatGPT account"). gpt-5.6-sol is what the account
# can run today. Override via env if it changes again.
CODEX_MODEL="${CODEX_MODEL:-gpt-5.6-sol}"
# Keep codex generation fast: the config default is xhigh reasoning, which
# makes a current codex grind for minutes over a haiku. Low is plenty here.
CODEX_REASONING="${CODEX_REASONING:-low}"
FETCH_TIMEOUT_SECONDS="${FETCH_TIMEOUT_SECONDS:-30}"
CLAUDE_TIMEOUT_SECONDS="${CLAUDE_TIMEOUT_SECONDS:-180}"
CODEX_TIMEOUT_SECONDS="${CODEX_TIMEOUT_SECONDS:-180}"
AGY_TIMEOUT_SECONDS="${AGY_TIMEOUT_SECONDS:-180}"
PUSH_TIMEOUT_SECONDS="${PUSH_TIMEOUT_SECONDS:-60}"
HEALTH_FETCH_TIMEOUT_SECONDS="${HEALTH_FETCH_TIMEOUT_SECONDS:-30}"
FETCH_RETRY_COUNT="${FETCH_RETRY_COUNT:-3}"
FETCH_RETRY_DELAY_SECONDS="${FETCH_RETRY_DELAY_SECONDS:-5}"
HEALTH_MAX_HAIKU_AGE_HOURS="${HEALTH_MAX_HAIKU_AGE_HOURS:-18}"
# Engines run every 6h; 13h tolerates one missed/retried cycle without
# alarming, but catches a silently-dead engine masked by the others still
# succeeding (haiku.txt itself stays "fresh" even if one engine is down).
HEALTH_MAX_ENGINE_AGE_HOURS="${HEALTH_MAX_ENGINE_AGE_HOURS:-13}"
NOTIFY_CONFIG_FILE="${NOTIFY_CONFIG_FILE:-$PROJECT_DIR/.notify.env}"
# Persistent, never-rotated, committed log of which model wrote each haiku —
# so mood/sentiment trends stay attributable to model changes over time.
MODEL_LOG="${MODEL_LOG:-$PROJECT_DIR/model.log}"

LOCK_BACKEND=""
LOCK_FD=""

# Reasoning effort named by an id's suffix ("gpt-oss-120b-medium" -> medium),
# else "default": no effort was requested, so the provider's default applied.
effort_from_id() {
    if [[ "$1" =~ -(xhigh|high|medium|low|minimal|none)$ ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo "default"
    fi
}

timestamp_utc() {
    date -u '+%Y-%m-%d %H:%M:%S UTC'
}

log() {
    echo "[$(timestamp_utc)] $*"
}

ensure_project_dir() {
    cd "$PROJECT_DIR" || return 1
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
    elif command -v gtimeout > /dev/null 2>&1; then
        gtimeout --foreground "${seconds}s" "$@"
    else
        # macOS does not ship timeout. Run the child in its own process group
        # when setsid is available, then enforce the deadline here so cron
        # cannot wait forever for a CLI or one of its descendants.
        local process_group=0
        if command -v setsid > /dev/null 2>&1; then
            setsid "$@" &
            process_group=1
        else
            "$@" &
        fi
        local pid=$!
        local deadline=$((SECONDS + seconds))

        while kill -0 "$pid" 2> /dev/null; do
            if [ "$SECONDS" -ge "$deadline" ]; then
                if [ "$process_group" -eq 1 ]; then
                    kill -TERM "-$pid" 2> /dev/null || true
                else
                    kill -TERM "$pid" 2> /dev/null || true
                fi
                sleep 1
                if [ "$process_group" -eq 1 ]; then
                    kill -KILL "-$pid" 2> /dev/null || true
                else
                    kill -KILL "$pid" 2> /dev/null || true
                fi
                wait "$pid" 2> /dev/null || true
                return 124
            fi
            sleep 1
        done

        wait "$pid"
    fi
}

retry() {
    local max_attempts="$1"
    local delay="$2"
    shift 2

    local attempt=1
    while [ "$attempt" -le "$max_attempts" ]; do
        if "$@"; then
            return 0
        fi
        if [ "$attempt" -lt "$max_attempts" ]; then
            log "Attempt $attempt/$max_attempts failed, retrying in ${delay}s..."
            sleep "$delay"
        fi
        attempt=$((attempt + 1))
    done
    return 1
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

# A conflicted stash apply/pop leaves unmerged index entries (and conflict
# markers in the worktree) while the surrounding command can still exit 0.
unmerged_paths_present() {
    [ -n "$(git ls-files -u)" ]
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
    grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC' haiku.txt | tail -1
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

last_engine_timestamp() {
    local engine="$1"
    grep "engine=$engine " "$MODEL_LOG" 2> /dev/null \
        | tail -1 \
        | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC'
}

last_engine_age_seconds() {
    local engine="$1"
    local last_timestamp
    local last_epoch
    local now_epoch

    last_timestamp="$(last_engine_timestamp "$engine")"
    [ -n "$last_timestamp" ] || return 1
    last_epoch="$(date -u -d "$last_timestamp" +%s)"
    now_epoch="$(date -u +%s)"

    echo $((now_epoch - last_epoch))
}
