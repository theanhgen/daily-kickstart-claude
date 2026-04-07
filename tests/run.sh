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

case "$mode" in
    success)
        printf '%s\n' \
            'morning sparrow sings' \
            'rooftops warming into gold' \
            'day opens its hands'
        ;;
    empty)
        ;;
    null)
        printf 'null\n'
        ;;
    fail)
        printf 'stubbed claude failure\n' >&2
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

    chmod +x "$project_dir/bin/claude" "$project_dir/bin/codex"
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
    assert_eq "ERROR: Unknown ENGINE=bogus (use claude or codex)" "$LAST_RUN_MESSAGE" "invalid ENGINE should explain the accepted values"
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
    run_test test_empty_output
    run_test test_null_output
    run_test test_successful_generation
    run_test test_write_status_round_trips_values
    run_test test_write_health_state_round_trips_values

    printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"

    if [ "$FAIL_COUNT" -ne 0 ]; then
        exit 1
    fi
}

main "$@"
