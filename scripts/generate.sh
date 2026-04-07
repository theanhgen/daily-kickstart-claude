#!/bin/bash

# Daily Kickstart - CLI Version
# Generates a haiku and appends to haiku.txt (no git operations).
# Commits are handled separately by the weekly push job.
# Supports ENGINE=claude (default) or ENGINE=codex.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"

ENGINE="${ENGINE:-claude}"
HAIKU_OUTPUT=""
HAIKU_ERROR=""

cleanup() {
    [ -n "$HAIKU_OUTPUT" ] && rm -f "$HAIKU_OUTPUT"
    [ -n "$HAIKU_ERROR" ] && rm -f "$HAIKU_ERROR"
    release_project_lock
}
trap cleanup EXIT

finish() {
    local exit_code="$1"
    local status="$2"
    local message="$3"

    write_status "$status" "kickstart-cli" "$message"
    log "$message"
    exit "$exit_code"
}

ensure_project_dir || finish 1 "project_dir_failed" "ERROR: Cannot access project directory: $PROJECT_DIR"
ensure_state_dir

if ! acquire_project_lock; then
    finish 1 "lock_unavailable" "ERROR: Another instance is already running"
fi

# Generate timestamp
TIMESTAMP="$(timestamp_utc)"
log "Generating haiku at $TIMESTAMP..."

# Create temp files for Claude output
HAIKU_OUTPUT=$(mktemp)
HAIKU_ERROR=$(mktemp)

# Read user prompt
PROMPT_FILE="$SCRIPT_DIR/session_prompt.txt"
if [ ! -f "$PROMPT_FILE" ]; then
    finish 1 "prompt_missing" "ERROR: $PROMPT_FILE not found"
fi
USER_PROMPT="$(cat "$PROMPT_FILE")"

# Generate haiku with proper error separation
case "$ENGINE" in
    claude)
        if ! run_with_timeout "$CLAUDE_TIMEOUT_SECONDS" "$CLAUDE_BIN" -p \
            --system-prompt "Output only the haiku, nothing else. No preamble, no explanation, just three lines." \
            "$USER_PROMPT" > "$HAIKU_OUTPUT" 2> "$HAIKU_ERROR"; then
            log "ERROR: Claude CLI failed"
            cat "$HAIKU_ERROR" >&2
            finish 1 "claude_failed" "ERROR: Claude CLI failed or timed out"
        fi
        ;;
    codex)
        if ! run_with_timeout "$CODEX_TIMEOUT_SECONDS" "$CODEX_BIN" exec \
            --ephemeral --skip-git-repo-check \
            -o "$HAIKU_OUTPUT" \
            "Output only a haiku, nothing else. No preamble, no explanation, just three lines. $USER_PROMPT" \
            2> "$HAIKU_ERROR"; then
            log "ERROR: Codex CLI failed"
            cat "$HAIKU_ERROR" >&2
            finish 1 "codex_failed" "ERROR: Codex CLI failed or timed out"
        fi
        ;;
    *)
        finish 1 "invalid_engine" "ERROR: Unknown ENGINE=$ENGINE (use claude or codex)"
        ;;
esac

# Extract and validate haiku (exactly 3 non-empty lines)
HAIKU=$(sed '/^$/d' "$HAIKU_OUTPUT" | tail -3)
LINE_COUNT=$(printf '%s' "$HAIKU" | awk 'NF { count++ } END { print count + 0 }')

if [ -z "$HAIKU" ] || [ "$HAIKU" = "null" ]; then
    log "ERROR: $ENGINE returned empty or null output"
    cat "$HAIKU_OUTPUT" >&2
    finish 1 "haiku_empty" "ERROR: $ENGINE returned empty or null output"
fi

if [ "$LINE_COUNT" -ne 3 ]; then
    log "WARNING: Haiku has $LINE_COUNT lines (expected 3), using anyway"
fi

# Append to haiku.txt with clean format
{
    echo ""
    echo "$TIMESTAMP [$ENGINE]"
    echo "$HAIKU"
} >> haiku.txt

finish 0 "success" "Haiku [$ENGINE] appended to haiku.txt"
