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
HAIKU_RAW=""
# "unknown" (never "default") is the honest record when an engine does not
# report the model it used — see the codex/agy branches below.
HAIKU_MODEL="unknown"

cleanup() {
    [ -n "$HAIKU_OUTPUT" ] && rm -f "$HAIKU_OUTPUT"
    [ -n "$HAIKU_ERROR" ] && rm -f "$HAIKU_ERROR"
    [ -n "$HAIKU_RAW" ] && rm -f "$HAIKU_RAW"
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
HAIKU_RAW=$(mktemp)

# Read user prompt
PROMPT_FILE="$SCRIPT_DIR/session_prompt.txt"
if [ ! -f "$PROMPT_FILE" ]; then
    finish 1 "prompt_missing" "ERROR: $PROMPT_FILE not found"
fi
USER_PROMPT="$(cat "$PROMPT_FILE")"

# Generate haiku with proper error separation
case "$ENGINE" in
    claude)
        # JSON output also reveals which model actually answered (modelUsage).
        if ! run_with_timeout "$CLAUDE_TIMEOUT_SECONDS" "$CLAUDE_BIN" -p --output-format json \
            --system-prompt "Output only the haiku, nothing else. No preamble, no explanation, just three lines." \
            "$USER_PROMPT" > "$HAIKU_RAW" 2> "$HAIKU_ERROR"; then
            log "ERROR: Claude CLI failed"
            cat "$HAIKU_ERROR" >&2
            # Auth/session failures often exit non-zero with empty stderr and
            # the real reason buried in the JSON on stdout instead — surface
            # it too so cron logs are actually diagnosable.
            cat "$HAIKU_RAW" >&2
            if grep -qiE 'OAuth token has expired|invalid_grant|not authenticated|Please run.*login|Invalid API key|authentication_error|Unauthorized' "$HAIKU_ERROR" "$HAIKU_RAW"; then
                finish 1 "claude_auth_failed" "ERROR: Claude CLI authentication failed — run 'claude /login'"
            fi
            finish 1 "claude_failed" "ERROR: Claude CLI failed or timed out"
        fi
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).result||"")+"\n")}catch{}})' < "$HAIKU_RAW" > "$HAIKU_OUTPUT" 2>/dev/null
        HAIKU_MODEL="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(Object.keys(JSON.parse(d).modelUsage||{})[0]||"unknown")}catch{process.stdout.write("unknown")}})' < "$HAIKU_RAW" 2>/dev/null || echo unknown)"
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
        # codex exec prints a startup banner to stderr ("model: gpt-5.4")
        # naming the model that actually answered. Record that, not the
        # configured pin: an unpinned run silently rolls to the provider
        # default (verified: gpt-5.5), and catching that roll is the whole
        # reason model.log exists. Fall back to the pin, then to "unknown" —
        # never "default", which would imply a reading we did not take.
        HAIKU_MODEL="$(awk '/^model:/ { print $2; exit }' "$HAIKU_ERROR" 2>/dev/null || true)"
        HAIKU_MODEL="${HAIKU_MODEL:-${CODEX_MODEL:-unknown}}"
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
        # agy reports no model id either: --output-format json returns only
        # conversation_id/status/response/usage, so record it as unreported
        # rather than letting the log imply a reading we never took.
        HAIKU_MODEL="unknown"
        ;;
    *)
        finish 1 "invalid_engine" "ERROR: Unknown ENGINE=$ENGINE (use claude, codex, or agy)"
        ;;
esac

# Extract and validate haiku (exactly 3 non-empty lines). Take *every*
# non-empty line: slicing here (the old `tail -3`) silently dropped the
# haiku's first line whenever an engine added a sign-off, and committed the
# prose in its place — the count stayed 3, so the guard below never fired.
HAIKU=$(awk 'NF' "$HAIKU_OUTPUT")
LINE_COUNT=$(printf '%s\n' "$HAIKU" | awk 'NF { count++ } END { print count + 0 }')

if [ -z "$HAIKU" ] || [ "$HAIKU" = "null" ]; then
    log "ERROR: $ENGINE returned empty or null output"
    cat "$HAIKU_OUTPUT" >&2
    finish 1 "haiku_empty" "ERROR: $ENGINE returned empty or null output"
fi

# A non-3-line entry corrupts haiku.txt parsing downstream (build-site.py
# reads exactly three body lines per entry) — better to lose one cycle.
if [ "$LINE_COUNT" -ne 3 ]; then
    log "ERROR: $ENGINE returned $LINE_COUNT lines (expected 3)"
    cat "$HAIKU_OUTPUT" >&2
    finish 1 "haiku_malformed" "ERROR: $ENGINE returned $LINE_COUNT lines (expected 3)"
fi

# Record which model wrote this haiku in the persistent model.log (never
# rotated, not in haiku.txt) so a future mood/sentiment trend can be
# attributed to model changes over time.
printf '%s engine=%s model=%s\n' "$TIMESTAMP" "$ENGINE" "${HAIKU_MODEL:-unknown}" >> "$MODEL_LOG"

# Append to haiku.txt with clean format
{
    echo ""
    echo "$TIMESTAMP [$ENGINE]"
    echo "$HAIKU"
} >> haiku.txt

finish 0 "success" "Haiku [$ENGINE] appended to haiku.txt"
