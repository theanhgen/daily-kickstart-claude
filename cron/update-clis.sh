#!/bin/bash
# Keep the generation CLIs current.
#
# The codex outage (the account's default model, gpt-5.5, outran the installed
# CLI) showed that a stale CLI silently drops an engine from every cycle. Run
# this on a schedule — ahead of the day's first generation — so the CLIs stay
# current on their own. Note: updating is necessary but not always sufficient
# (sometimes even the latest CLI lags a new server model); generate.sh still
# fails such an engine cleanly and the others keep running.
set -uo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=/dev/null
. scripts/lib.sh
load_notify_config

changed=()
failed=()

update_one() {
    local name="$1" bin="$2"
    local before after

    if [ ! -x "$bin" ] && ! command -v "$bin" > /dev/null 2>&1; then
        log "CLI update: $name not found ($bin), skipping"
        return
    fi

    before="$("$bin" --version 2>/dev/null | head -1)" || before="?"
    if ! run_with_timeout 300 "$bin" update >> kickstart.log 2>&1; then
        log "CLI update: $name FAILED"
        failed+=("$name")
        return
    fi
    after="$("$bin" --version 2>/dev/null | head -1)" || after="?"

    if [ "$before" != "$after" ]; then
        log "CLI update: $name $before -> $after"
        changed+=("$name: $before -> $after")
    else
        log "CLI update: $name already current ($after)"
    fi
}

update_one claude "$CLAUDE_BIN"
update_one codex "$CODEX_BIN"
update_one agy "$AGY_BIN"

if [ "${#failed[@]}" -gt 0 ]; then
    scripts/notify.sh error "$PROJECT_NAME CLI update failed" \
        "$(printf '%s ' "${failed[@]}")" || true
    exit 1
fi

if [ "${#changed[@]}" -gt 0 ]; then
    scripts/notify.sh info "$PROJECT_NAME CLIs updated" \
        "$(printf '%s; ' "${changed[@]}")" || true
fi

exit 0
