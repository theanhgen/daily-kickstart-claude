#!/bin/bash

# Daily Kickstart Claude - CLI Version
# Generates a haiku and appends to haiku.txt (no git operations).
# Commits are handled separately by the weekly push job.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"

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
if ! run_with_timeout "$CLAUDE_TIMEOUT_SECONDS" "$CLAUDE_BIN" -p \
    --system-prompt "Output only the haiku, nothing else. No preamble, no explanation, just three lines." \
    "$USER_PROMPT" > "$HAIKU_OUTPUT" 2> "$HAIKU_ERROR"; then
    log "ERROR: Claude CLI failed"
    cat "$HAIKU_ERROR" >&2
    finish 1 "claude_failed" "ERROR: Claude CLI failed or timed out"
fi

# Extract and validate haiku (exactly 3 non-empty lines)
HAIKU=$(sed '/^$/d' "$HAIKU_OUTPUT" | tail -3)
LINE_COUNT=$(printf '%s' "$HAIKU" | awk 'NF { count++ } END { print count + 0 }')

if [ -z "$HAIKU" ] || [ "$HAIKU" = "null" ]; then
    log "ERROR: Claude returned empty or null output"
    cat "$HAIKU_OUTPUT" >&2
    finish 1 "haiku_empty" "ERROR: Claude returned empty or null output"
fi

if [ "$LINE_COUNT" -ne 3 ]; then
    log "WARNING: Haiku has $LINE_COUNT lines (expected 3), using anyway"
fi

# Append to haiku.txt with clean format
{
    echo ""
    echo "$TIMESTAMP"
    echo "$HAIKU"
} >> haiku.txt

finish 0 "success" "Haiku appended to haiku.txt"
