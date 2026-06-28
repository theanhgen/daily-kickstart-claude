#!/bin/bash

# Daily Kickstart - CLI Version
# Generates a haiku and appends to haiku.txt (no git operations).
# Commits are handled separately by the weekly push job.
# Supports ENGINE=claude (default), ENGINE=codex, or ENGINE=agy.

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
        CODEX_ARGS=(exec --ephemeral --skip-git-repo-check)
        [ -n "$CODEX_MODEL" ] && CODEX_ARGS+=(-m "$CODEX_MODEL")
        [ -n "$CODEX_REASONING" ] && CODEX_ARGS+=(-c "model_reasoning_effort=$CODEX_REASONING")
        CODEX_ARGS+=(-o "$HAIKU_OUTPUT")
        # < /dev/null: codex exec reads stdin and hangs on an open pipe.
        if ! run_with_timeout "$CODEX_TIMEOUT_SECONDS" "$CODEX_BIN" "${CODEX_ARGS[@]}" \
            "Output only a haiku, nothing else. No preamble, no explanation, just three lines. $USER_PROMPT" \
            < /dev/null 2> "$HAIKU_ERROR"; then
            log "ERROR: Codex CLI failed"
            cat "$HAIKU_ERROR" >&2
            # Distinguish "the CLI is out of date / model unavailable" (needs
            # an upgrade or a CODEX_MODEL pin) from a plain timeout, so the
            # operator alert is actionable.
            if grep -qiE 'requires a newer version|not supported|please upgrade' "$HAIKU_ERROR"; then
                finish 1 "codex_needs_upgrade" "ERROR: Codex CLI out of date or model unavailable — run 'codex update' or set CODEX_MODEL"
            fi
            finish 1 "codex_failed" "ERROR: Codex CLI failed or timed out"
        fi
        ;;
    agy)
        # agy -p reads stdin until EOF; without </dev/null it hangs on the
        # inherited pipe under cron until the timeout fires.
        if ! run_with_timeout "$AGY_TIMEOUT_SECONDS" "$AGY_BIN" -p \
            "Output only the haiku, nothing else. No preamble, no explanation, just three lines. $USER_PROMPT" \
            < /dev/null > "$HAIKU_OUTPUT" 2> "$HAIKU_ERROR"; then
            log "ERROR: Antigravity CLI failed"
            cat "$HAIKU_ERROR" >&2
            if grep -qiE 'requires a newer version|not supported|please upgrade|no longer supported' "$HAIKU_ERROR"; then
                finish 1 "agy_needs_upgrade" "ERROR: Antigravity CLI out of date or tier unsupported — run 'agy update'"
            fi
            finish 1 "agy_failed" "ERROR: Antigravity CLI failed or timed out"
        fi
        # agy prints an OAuth login blob to stdout and still exits 0 when
        # unauthenticated; guard so we never append that to haiku.txt.
        if grep -qiE 'Authentication required|authentication timed out' "$HAIKU_OUTPUT"; then
            log "ERROR: Antigravity CLI not authenticated"
            cat "$HAIKU_OUTPUT" >&2
            finish 1 "agy_unauthenticated" "ERROR: Antigravity CLI not authenticated (run 'agy -p test' to log in)"
        fi
        ;;
    *)
        finish 1 "invalid_engine" "ERROR: Unknown ENGINE=$ENGINE (use claude, codex, or agy)"
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

# Stamp the engine's CLI version and model in the LOG (not in haiku.txt) so a
# future mood/sentiment trend can be attributed to model changes over time.
case "$ENGINE" in
    claude) VER_BIN="$CLAUDE_BIN"; VER_MODEL="default" ;;
    codex)  VER_BIN="$CODEX_BIN";  VER_MODEL="${CODEX_MODEL:-default}" ;;
    agy)    VER_BIN="$AGY_BIN";    VER_MODEL="default" ;;
    *)      VER_BIN="";            VER_MODEL="" ;;
esac
VER_CLI="$("$VER_BIN" --version 2>/dev/null | head -1 || true)"
log "version engine=$ENGINE cli=\"${VER_CLI:-unknown}\" model=$VER_MODEL"

# Append to haiku.txt with clean format
{
    echo ""
    echo "$TIMESTAMP [$ENGINE]"
    echo "$HAIKU"
} >> haiku.txt

finish 0 "success" "Haiku [$ENGINE] appended to haiku.txt"
