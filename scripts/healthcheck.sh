#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib.sh"

ensure_project_dir
ensure_state_dir

if ! acquire_project_lock; then
    log "INFO: Skipping healthcheck because another repo job is running"
    exit 0
fi
trap release_project_lock EXIT

load_notify_config

errors=()

if run_with_timeout "$HEALTH_FETCH_TIMEOUT_SECONDS" git fetch "$REMOTE_NAME" "$BRANCH_NAME" > /dev/null 2>&1; then
    set -- $(git_divergence_counts)
    BEHIND_COUNT="${1:-0}"
    AHEAD_COUNT="${2:-0}"

    if [ "$BEHIND_COUNT" -ne 0 ]; then
        errors+=("branch is behind remote (behind=$BEHIND_COUNT ahead=$AHEAD_COUNT)")
    fi
else
    errors+=("git fetch failed")
fi

LAST_HAIKU_TIMESTAMP=""
LAST_HAIKU_AGE_HOURS="unknown"

if LAST_HAIKU_TIMESTAMP="$(last_haiku_timestamp 2> /dev/null)"; then
    LAST_HAIKU_AGE_SECONDS="$(last_haiku_age_seconds 2> /dev/null || echo -1)"
    if [ "$LAST_HAIKU_AGE_SECONDS" -lt 0 ]; then
        errors+=("could not calculate last haiku age")
    else
        LAST_HAIKU_AGE_HOURS=$((LAST_HAIKU_AGE_SECONDS / 3600))
        if [ "$LAST_HAIKU_AGE_SECONDS" -gt $((HEALTH_MAX_HAIKU_AGE_HOURS * 3600)) ]; then
            errors+=("last haiku is ${LAST_HAIKU_AGE_HOURS}h old (threshold ${HEALTH_MAX_HAIKU_AGE_HOURS}h)")
        fi
    fi
else
    errors+=("could not determine last haiku timestamp")
fi

if [ -f "$STATUS_FILE" ]; then
    unset LAST_RUN_TIMESTAMP LAST_RUN_STATUS LAST_RUN_CONTEXT LAST_RUN_MESSAGE LAST_RUN_COMMIT
    load_status_file "$STATUS_FILE"
    if [ "${LAST_RUN_CONTEXT:-}" = "kickstart-cli" ]; then
        case "${LAST_RUN_STATUS:-unknown}" in
            success|noop|local_only)
                ;;
            *)
                errors+=("last kickstart status is ${LAST_RUN_STATUS:-unknown}: ${LAST_RUN_MESSAGE:-no message}")
                ;;
        esac
    fi
fi

CURRENT_HEALTH_STATUS="ok"
CURRENT_HEALTH_SUMMARY="healthy"

if [ "${#errors[@]}" -gt 0 ]; then
    CURRENT_HEALTH_STATUS="error"
    CURRENT_HEALTH_SUMMARY="$(printf '%s; ' "${errors[@]}")"
    CURRENT_HEALTH_SUMMARY="${CURRENT_HEALTH_SUMMARY%; }"
fi

PREVIOUS_HEALTH_STATUS="unknown"
PREVIOUS_HEALTH_SUMMARY=""

if [ -f "$HEALTH_STATE_FILE" ]; then
    unset LAST_HEALTH_TIMESTAMP LAST_HEALTH_STATUS LAST_HEALTH_SUMMARY
    load_status_file "$HEALTH_STATE_FILE"
    PREVIOUS_HEALTH_STATUS="${LAST_HEALTH_STATUS:-unknown}"
    PREVIOUS_HEALTH_SUMMARY="${LAST_HEALTH_SUMMARY:-}"
fi

if [ "$CURRENT_HEALTH_STATUS" = "error" ]; then
    log "ERROR: $CURRENT_HEALTH_SUMMARY"
    if [ "$PREVIOUS_HEALTH_STATUS" != "error" ] || [ "$PREVIOUS_HEALTH_SUMMARY" != "$CURRENT_HEALTH_SUMMARY" ]; then
        "$SCRIPT_DIR/notify.sh" error \
            "$PROJECT_NAME healthcheck failed" \
            "$CURRENT_HEALTH_SUMMARY" || true
    fi
    write_health_state "$CURRENT_HEALTH_STATUS" "$CURRENT_HEALTH_SUMMARY"
    exit 1
fi

SUCCESS_SUMMARY="last haiku ${LAST_HAIKU_TIMESTAMP:-unknown}; age=${LAST_HAIKU_AGE_HOURS}h; branch synchronized"
log "OK: $SUCCESS_SUMMARY"

if [ "$PREVIOUS_HEALTH_STATUS" = "error" ]; then
    "$SCRIPT_DIR/notify.sh" info \
        "$PROJECT_NAME recovered" \
        "$SUCCESS_SUMMARY" || true
fi

write_health_state "$CURRENT_HEALTH_STATUS" "$SUCCESS_SUMMARY"
