#!/usr/bin/env bash

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS_COUNT=0
FAIL_COUNT=0
RUN_OUTPUT=""
RUN_STATUS=0

pass() {
    printf 'ok - %s\n' "$1"
    PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
    printf 'not ok - %s\n' "$1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
}

assert_eq() {
    local expected="$1"
    local actual="$2"
    local message="$3"

    if [ "$actual" != "$expected" ]; then
        printf 'ASSERTION FAILED: %s\n' "$message" >&2
        printf '  expected: %s\n' "$expected" >&2
        printf '  actual:   %s\n' "$actual" >&2
        return 1
    fi
}

assert_match() {
    local pattern="$1"
    local actual="$2"
    local message="$3"

    if [[ ! "$actual" =~ $pattern ]]; then
        printf 'ASSERTION FAILED: %s\n' "$message" >&2
        printf '  pattern: %s\n' "$pattern" >&2
        printf '  actual:  %s\n' "$actual" >&2
        return 1
    fi
}

assert_file_exists() {
    local path="$1"
    local message="$2"

    if [ ! -f "$path" ]; then
        printf 'ASSERTION FAILED: %s\n' "$message" >&2
        printf '  missing file: %s\n' "$path" >&2
        return 1
    fi
}

assert_file_missing() {
    local path="$1"
    local message="$2"

    if [ -e "$path" ]; then
        printf 'ASSERTION FAILED: %s\n' "$message" >&2
        printf '  unexpected path: %s\n' "$path" >&2
        return 1
    fi
}

assert_file_contains() {
    local path="$1"
    local needle="$2"
    local message="$3"

    if ! grep -Fq -- "$needle" "$path"; then
        printf 'ASSERTION FAILED: %s\n' "$message" >&2
        printf '  file:   %s\n' "$path" >&2
        printf '  needle: %s\n' "$needle" >&2
        return 1
    fi
}

setup_project() {
    local project_dir
    project_dir="$(mktemp -d)"

    mkdir -p "$project_dir/scripts" "$project_dir/bin"
    cp "$REPO_DIR/scripts/generate.sh" "$project_dir/scripts/generate.sh"
    cp "$REPO_DIR/scripts/lib.sh" "$project_dir/scripts/lib.sh"
    chmod +x "$project_dir/scripts/generate.sh"

    cat > "$project_dir/bin/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

mode="${GENERATE_STUB_MODE:-success}"

# generate.sh calls claude with --output-format json and parses .result /
# .modelUsage with node, so the stub emits JSON like the real CLI does.
case "$mode" in
    success)
        printf '%s\n' '{"result":"morning sparrow sings\nrooftops warming into gold\nday opens its hands","modelUsage":{"claude-stub":{}}}'
        ;;
    empty)
        ;;
    null)
        printf 'null\n'
        ;;
    twolines)
        printf '%s\n' '{"result":"just two\nlines here","modelUsage":{"claude-stub":{}}}'
        ;;
    fail)
        printf 'stubbed claude failure\n' >&2
        exit 1
        ;;
    authfail)
        # Mirrors the real CLI's auth-failure shape: empty stderr, the
        # actual reason buried in the JSON on stdout.
        printf '%s\n' '{"is_error":true,"result":"OAuth token has expired. Please run claude login to reauthenticate."}'
        exit 1
        ;;
    *)
        printf '%s\n' "$mode"
        ;;
esac
EOF

    cat > "$project_dir/bin/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output_file=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        -o)
            output_file="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

mode="${GENERATE_STUB_MODE:-success}"

# The real codex exec prints a startup banner to stderr naming the model that
# answered; generate.sh parses it back out of $HAIKU_ERROR. Set the variable
# to the empty string to simulate a CLI that prints no banner.
banner_model="${CODEX_STUB_BANNER_MODEL-gpt-stub-banner}"
if [ -n "$banner_model" ]; then
    printf 'model: %s\nreasoning effort: xhigh\n' "$banner_model" >&2
fi

case "$mode" in
    success)
        printf '%s\n' \
            'morning sparrow sings' \
            'rooftops warming into gold' \
            'day opens its hands' > "$output_file"
        ;;
    empty)
        : > "$output_file"
        ;;
    null)
        printf 'null\n' > "$output_file"
        ;;
    fail)
        printf 'stubbed codex failure\n' >&2
        exit 1
        ;;
    *)
        printf '%s\n' "$mode" > "$output_file"
        ;;
esac
EOF

    cat > "$project_dir/bin/agy" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# agy -p prints the haiku as plain text to stdout (no JSON wrapper).
mode="${GENERATE_STUB_MODE:-success}"

case "$mode" in
    success)
        printf '%s\n' \
            'morning sparrow sings' \
            'rooftops warming into gold' \
            'day opens its hands'
        ;;
    empty)
        ;;
    trailingprose)
        # A valid haiku followed by a sign-off: 4 non-empty lines, which the
        # old `tail -3` reshaped into a well-formed-looking 3-line entry.
        printf '%s\n' \
            'morning sparrow sings' \
            'rooftops warming into gold' \
            'day opens its hands' \
            '' \
            '(Hope you like it!)'
        ;;
    unauth)
        # agy exits 0 but prints a login blob when not authenticated.
        printf 'Authentication required: run agy -p test to log in\n'
        ;;
    fail)
        printf 'stubbed agy failure\n' >&2
        exit 1
        ;;
    *)
        printf '%s\n' "$mode"
        ;;
esac
EOF

    chmod +x "$project_dir/bin/claude" "$project_dir/bin/codex" "$project_dir/bin/agy"
    printf '%s\n' 'Write a haiku about the weather.' > "$project_dir/scripts/session_prompt.txt"

    printf '%s\n' "$project_dir"
}

run_generate() {
    local project_dir="$1"
    shift

    set +e
    RUN_OUTPUT="$(
        env \
            PROJECT_DIR="$project_dir" \
            STATE_DIR="$project_dir/.runtime" \
            STATUS_FILE="$project_dir/.runtime/last_run.env" \
            LOCK_FILE="$project_dir/.runtime/kickstart.lock" \
            CLAUDE_BIN="$project_dir/bin/claude" \
            CODEX_BIN="$project_dir/bin/codex" \
            AGY_BIN="$project_dir/bin/agy" \
            "$@" \
            bash "$project_dir/scripts/generate.sh" 2>&1
    )"
    RUN_STATUS=$?
    set -e
}

test_missing_prompt_file() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT
    rm -f "$project_dir/scripts/session_prompt.txt"

    run_generate "$project_dir"
    assert_eq "1" "$RUN_STATUS" "missing prompt should fail"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "missing prompt should still write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "prompt_missing" "$LAST_RUN_STATUS" "missing prompt should record prompt_missing"
    assert_eq "kickstart-cli" "$LAST_RUN_CONTEXT" "missing prompt should keep the CLI context"
    assert_eq "ERROR: $project_dir/scripts/session_prompt.txt not found" "$LAST_RUN_MESSAGE" "missing prompt should record the prompt path"
    assert_eq "unknown" "$LAST_RUN_COMMIT" "temp project without git should report an unknown commit"
    assert_file_missing "$project_dir/haiku.txt" "missing prompt should not create haiku output"
}

test_invalid_engine() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" ENGINE=bogus
    assert_eq "1" "$RUN_STATUS" "invalid ENGINE should fail"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "invalid ENGINE should write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "invalid_engine" "$LAST_RUN_STATUS" "invalid ENGINE should record invalid_engine"
    assert_eq "ERROR: Unknown ENGINE=bogus (use claude, codex, or agy)" "$LAST_RUN_MESSAGE" "invalid ENGINE should explain the accepted values"
    assert_file_missing "$project_dir/haiku.txt" "invalid ENGINE should not create haiku output"
}

test_claude_failure() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" GENERATE_STUB_MODE=fail
    assert_eq "1" "$RUN_STATUS" "CLI failure should fail the run"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "CLI failure should write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "claude_failed" "$LAST_RUN_STATUS" "Claude failure should record claude_failed"
    assert_eq "ERROR: Claude CLI failed or timed out" "$LAST_RUN_MESSAGE" "Claude failure should record the timeout/error message"
    assert_match 'stubbed claude failure' "$RUN_OUTPUT" "Claude failure should surface stderr from the stub"
    assert_file_missing "$project_dir/haiku.txt" "CLI failure should not create haiku output"
}

test_claude_auth_failure() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" GENERATE_STUB_MODE=authfail
    assert_eq "1" "$RUN_STATUS" "auth failure should fail the run"

    status_file="$project_dir/.runtime/last_run.env"
    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "claude_auth_failed" "$LAST_RUN_STATUS" "auth failure should record claude_auth_failed"
    assert_eq "ERROR: Claude CLI authentication failed — run 'claude /login'" "$LAST_RUN_MESSAGE" "auth failure should record an actionable message"
    assert_match 'OAuth token has expired' "$RUN_OUTPUT" "auth failure should surface the reason from stdout"
    assert_file_missing "$project_dir/haiku.txt" "auth failure should not create haiku output"
}

test_empty_output() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" GENERATE_STUB_MODE=empty
    assert_eq "1" "$RUN_STATUS" "empty output should fail"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "empty output should write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "haiku_empty" "$LAST_RUN_STATUS" "empty output should record haiku_empty"
    assert_eq "ERROR: claude returned empty or null output" "$LAST_RUN_MESSAGE" "empty output should mention empty or null output"
    assert_file_missing "$project_dir/haiku.txt" "empty output should not create haiku output"
}

test_null_output() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" GENERATE_STUB_MODE=null
    assert_eq "1" "$RUN_STATUS" "null output should fail"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "null output should write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "haiku_empty" "$LAST_RUN_STATUS" "null output should record haiku_empty"
    assert_eq "ERROR: claude returned empty or null output" "$LAST_RUN_MESSAGE" "null output should mention empty or null output"
    assert_file_missing "$project_dir/haiku.txt" "null output should not create haiku output"
}

test_malformed_haiku() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" GENERATE_STUB_MODE=twolines
    assert_eq "1" "$RUN_STATUS" "non-3-line output should fail"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "non-3-line output should write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "haiku_malformed" "$LAST_RUN_STATUS" "non-3-line output should record haiku_malformed"
    assert_eq "ERROR: claude returned 2 lines (expected 3)" "$LAST_RUN_MESSAGE" "non-3-line output should report the line count"
    assert_file_missing "$project_dir/haiku.txt" "non-3-line output should not create haiku output"
    assert_file_missing "$project_dir/model.log" "non-3-line output should not record a model.log entry"
}

test_successful_generation() {
    local project_dir
    local status_file
    local -a lines

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir"
    assert_eq "0" "$RUN_STATUS" "successful generation should exit cleanly"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "successful generation should write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "success" "$LAST_RUN_STATUS" "successful generation should record success"
    assert_eq "Haiku [claude] appended to haiku.txt" "$LAST_RUN_MESSAGE" "successful generation should record a success message"

    assert_file_exists "$project_dir/haiku.txt" "successful generation should create haiku.txt"
    mapfile -t lines < "$project_dir/haiku.txt"
    assert_eq "" "${lines[0]}" "successful generation should keep the blank separator line"
    assert_match '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC \[claude\]$' "${lines[1]}" "successful generation should write a timestamped engine header"
    assert_eq "morning sparrow sings" "${lines[2]}" "successful generation should write the first haiku line"
    assert_eq "rooftops warming into gold" "${lines[3]}" "successful generation should write the second haiku line"
    assert_eq "day opens its hands" "${lines[4]}" "successful generation should write the third haiku line"
}

test_agy_successful_generation() {
    local project_dir
    local status_file
    local -a lines

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" ENGINE=agy
    assert_eq "0" "$RUN_STATUS" "agy generation should exit cleanly"

    status_file="$project_dir/.runtime/last_run.env"
    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "success" "$LAST_RUN_STATUS" "agy generation should record success"
    assert_eq "Haiku [agy] appended to haiku.txt" "$LAST_RUN_MESSAGE" "agy generation should record a success message"

    assert_file_exists "$project_dir/haiku.txt" "agy generation should create haiku.txt"
    mapfile -t lines < "$project_dir/haiku.txt"
    assert_match '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC \[agy\]$' "${lines[1]}" "agy generation should write a timestamped engine header"
    assert_eq "morning sparrow sings" "${lines[2]}" "agy generation should write the first haiku line"
}

test_agy_unauthenticated() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" ENGINE=agy GENERATE_STUB_MODE=unauth
    assert_eq "1" "$RUN_STATUS" "unauthenticated agy should fail"

    status_file="$project_dir/.runtime/last_run.env"
    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "agy_unauthenticated" "$LAST_RUN_STATUS" "unauthenticated agy should record agy_unauthenticated"
    assert_file_missing "$project_dir/haiku.txt" "unauthenticated agy should not create haiku output"
}

test_trailing_prose_rejected() {
    local project_dir
    local status_file

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" ENGINE=agy GENERATE_STUB_MODE=trailingprose
    assert_eq "1" "$RUN_STATUS" "a sign-off after the haiku should fail the cycle"

    status_file="$project_dir/.runtime/last_run.env"
    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "haiku_malformed" "$LAST_RUN_STATUS" "trailing prose should record haiku_malformed"
    assert_eq "ERROR: agy returned 4 lines (expected 3)" "$LAST_RUN_MESSAGE" "trailing prose should report all 4 non-empty lines, not the sliced 3"
    # The regression: tail -3 dropped line 1 and committed the sign-off.
    assert_file_missing "$project_dir/haiku.txt" "trailing prose should not commit a shifted haiku"
    assert_file_missing "$project_dir/model.log" "trailing prose should not record a model.log entry"
}

test_agy_records_unknown_model() {
    local project_dir

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    run_generate "$project_dir" ENGINE=agy
    assert_eq "0" "$RUN_STATUS" "agy generation should exit cleanly"

    # agy reports no model id, so the log must say so rather than logging the
    # literal "default", which reads as a model that never changes.
    assert_file_exists "$project_dir/model.log" "agy generation should record a model.log entry"
    assert_file_contains "$project_dir/model.log" "engine=agy model=unknown" "agy should record an unreported model as unknown"
}

test_codex_records_model_that_answered() {
    local project_dir

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    # The pin and the model that actually answered deliberately disagree: an
    # unpinned or silently-rolled run is exactly the event model.log exists to
    # catch, so the banner must win over the configured pin.
    run_generate "$project_dir" ENGINE=codex CODEX_MODEL=gpt-stub-pin \
        CODEX_STUB_BANNER_MODEL=gpt-stub-actual
    assert_eq "0" "$RUN_STATUS" "codex generation should exit cleanly"

    assert_file_exists "$project_dir/model.log" "codex generation should record a model.log entry"
    assert_file_contains "$project_dir/model.log" "engine=codex model=gpt-stub-actual" "codex should record the model from the banner, not the pin"
}

test_codex_falls_back_to_pin_without_banner() {
    local project_dir

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    # No banner (an older CLI, or a changed banner format): the pin is the
    # best remaining record — but still never the literal "default".
    run_generate "$project_dir" ENGINE=codex CODEX_MODEL=gpt-stub-pin \
        CODEX_STUB_BANNER_MODEL=
    assert_eq "0" "$RUN_STATUS" "codex generation should exit cleanly"

    assert_file_contains "$project_dir/model.log" "engine=codex model=gpt-stub-pin" "codex should fall back to the configured pin"
}

test_write_status_round_trips_values() {
    local project_dir

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    cd "$project_dir"
    PROJECT_DIR="$project_dir"
    STATE_DIR="$project_dir/state"
    STATUS_FILE="$project_dir/state/last_run.env"

    # shellcheck source=/dev/null
    . "$project_dir/scripts/lib.sh"
    write_status "needs_attention" "status-tests" "message with spaces, quotes, and \$dollar signs"

    unset LAST_RUN_TIMESTAMP LAST_RUN_STATUS LAST_RUN_CONTEXT LAST_RUN_MESSAGE LAST_RUN_COMMIT
    load_status_file "$STATUS_FILE"

    assert_eq "needs_attention" "$LAST_RUN_STATUS" "write_status should preserve the status"
    assert_eq "status-tests" "$LAST_RUN_CONTEXT" "write_status should preserve the context"
    assert_eq "message with spaces, quotes, and \$dollar signs" "$LAST_RUN_MESSAGE" "write_status should preserve shell-sensitive characters"
    assert_eq "unknown" "$LAST_RUN_COMMIT" "write_status should use unknown without a git HEAD"
    assert_match 'UTC$' "$LAST_RUN_TIMESTAMP" "write_status should record a UTC timestamp"
}

test_write_health_state_round_trips_values() {
    local project_dir

    project_dir="$(setup_project)"
    trap "rm -rf '$project_dir'" EXIT

    cd "$project_dir"
    PROJECT_DIR="$project_dir"
    STATE_DIR="$project_dir/state"
    HEALTH_STATE_FILE="$project_dir/state/health.env"

    # shellcheck source=/dev/null
    . "$project_dir/scripts/lib.sh"
    write_health_state "warning" "summary with spaces, brackets [ok], and \$dollar signs"

    unset LAST_HEALTH_TIMESTAMP LAST_HEALTH_STATUS LAST_HEALTH_SUMMARY
    load_status_file "$HEALTH_STATE_FILE"

    assert_eq "warning" "$LAST_HEALTH_STATUS" "write_health_state should preserve the status"
    assert_eq "summary with spaces, brackets [ok], and \$dollar signs" "$LAST_HEALTH_SUMMARY" "write_health_state should preserve shell-sensitive characters"
    assert_match 'UTC$' "$LAST_HEALTH_TIMESTAMP" "write_health_state should record a UTC timestamp"
}

setup_sync_repo() {
    local project_dir
    project_dir="$(mktemp -d)"

    mkdir -p "$project_dir/scripts" "$project_dir/notes"
    cp "$REPO_DIR/scripts/sync.sh" "$project_dir/scripts/sync.sh"
    cp "$REPO_DIR/scripts/lib.sh" "$project_dir/scripts/lib.sh"

    git -C "$project_dir" init -q
    git -C "$project_dir" config user.email "tests@example.invalid"
    git -C "$project_dir" config user.name "sync tests"

    printf 'haiku\n' > "$project_dir/haiku.txt"
    printf 'model\n' > "$project_dir/model.log"
    # Tracked paths that merely *end* in the automation's output names. The
    # dirty-worktree gate must treat these as a human's files, not its own.
    printf 'human notes\n' > "$project_dir/notes/my_haiku.txt"
    printf 'human log\n' > "$project_dir/test_model.log"
    printf 'unrelated\n' > "$project_dir/old.txt"
    git -C "$project_dir" add -A > /dev/null
    git -C "$project_dir" commit -qm "init" > /dev/null

    printf '%s\n' "$project_dir"
}

run_sync() {
    local project_dir="$1"

    set +e
    RUN_OUTPUT="$(
        env \
            PROJECT_DIR="$project_dir" \
            STATE_DIR="$project_dir/.runtime" \
            STATUS_FILE="$project_dir/.runtime/last_run.env" \
            LOCK_FILE="$project_dir/.runtime/kickstart.lock" \
            FETCH_RETRY_COUNT=1 \
            FETCH_RETRY_DELAY_SECONDS=0 \
            bash "$project_dir/scripts/sync.sh" 2>&1
    )"
    RUN_STATUS=$?
    set -e
}

test_sync_refuses_lookalike_dirty_path() {
    local project_dir
    local status_file

    project_dir="$(setup_sync_repo)"
    trap "rm -rf '$project_dir'" EXIT

    # A human mid-edit on their own file. The gate used to match the porcelain
    # lines with an end-anchored regex, so notes/my_haiku.txt was filtered out
    # as if it were the automation's haiku.txt and --autostash carried the edit
    # across the unattended rebase.
    printf 'HUMAN EDIT\n' >> "$project_dir/notes/my_haiku.txt"

    run_sync "$project_dir"
    assert_eq "1" "$RUN_STATUS" "a dirty lookalike path should stop the sync"

    status_file="$project_dir/.runtime/last_run.env"
    assert_file_exists "$status_file" "a refused sync should write status"

    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "sync_foreign_changes" "$LAST_RUN_STATUS" "notes/my_haiku.txt should trip the foreign-changes gate"
}

test_sync_refuses_lookalike_rename() {
    local project_dir
    local status_file

    project_dir="$(setup_sync_repo)"
    trap "rm -rf '$project_dir'" EXIT

    # Rename lines carry two paths, so the end-anchored regex matched on the
    # destination and swallowed the whole line. (A rename onto the real
    # top-level haiku.txt trips the gate too: its deleted source still shows.)
    git -C "$project_dir" mv old.txt src_haiku.txt

    run_sync "$project_dir"
    assert_eq "1" "$RUN_STATUS" "a staged rename to a lookalike path should stop the sync"

    status_file="$project_dir/.runtime/last_run.env"
    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "sync_foreign_changes" "$LAST_RUN_STATUS" "a rename ending in haiku.txt should trip the foreign-changes gate"
}

test_sync_allows_dirty_outputs() {
    local project_dir
    local status_file

    project_dir="$(setup_sync_repo)"
    trap "rm -rf '$project_dir'" EXIT

    # The normal mid-week state: only the automation's own outputs are dirty.
    # The gate must let this through (the run then stops at the fetch, since
    # the throwaway repo has no remote) — otherwise the daily sync never runs.
    printf 'more haiku\n' >> "$project_dir/haiku.txt"
    printf 'more model\n' >> "$project_dir/model.log"

    run_sync "$project_dir"
    assert_eq "1" "$RUN_STATUS" "the remote-less test repo should fail at the fetch"

    status_file="$project_dir/.runtime/last_run.env"
    # shellcheck source=/dev/null
    . "$status_file"
    assert_eq "sync_fetch_failed" "$LAST_RUN_STATUS" "dirty haiku.txt/model.log alone must pass the foreign-changes gate"
}

run_test() {
    local name="$1"

    if ( "$name" ); then
        pass "$name"
    else
        fail "$name"
    fi
}

main() {
    run_test test_missing_prompt_file
    run_test test_invalid_engine
    run_test test_claude_failure
    run_test test_claude_auth_failure
    run_test test_empty_output
    run_test test_null_output
    run_test test_malformed_haiku
    run_test test_successful_generation
    run_test test_agy_successful_generation
    run_test test_agy_unauthenticated
    run_test test_trailing_prose_rejected
    run_test test_agy_records_unknown_model
    run_test test_codex_records_model_that_answered
    run_test test_codex_falls_back_to_pin_without_banner
    run_test test_write_status_round_trips_values
    run_test test_write_health_state_round_trips_values
    run_test test_sync_refuses_lookalike_dirty_path
    run_test test_sync_refuses_lookalike_rename
    run_test test_sync_allows_dirty_outputs

    printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"

    if [ "$FAIL_COUNT" -ne 0 ]; then
        exit 1
    fi
}

main "$@"
