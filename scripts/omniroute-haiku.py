#!/usr/bin/env python3
"""Ask every free model on local OmniRoute for a haiku and store the answers in SQLite.

A bench, not a fourth engine: nothing here touches haiku.txt, model.log or the site.
Runs on the Mac that hosts OmniRoute, not on the Pi, from that Mac's user crontab:

    1 6,11,16,21 * * * PATH=/opt/homebrew/bin:/usr/bin:/bin /opt/homebrew/bin/python3 \
        <repo>/scripts/omniroute-haiku.py >> ~/Library/Logs/omniroute-haiku.log 2>&1

Cron calls python3 directly, with no shell wrapper and a log outside ~/Desktop, because
macOS privacy protection blocks /bin/bash (and launchd jobs) from reading this repo
under ~/Desktop ("Operation not permitted") while Homebrew's python3 is allowed. A run
that falls while the Mac sleeps is skipped, not made up. Failures go to the log, never
to ntfy.

The free roster comes from the multireview runner's `roster` subcommand, which owns the
cost table that decides what counts as free. Reading it from there keeps one copy of
that table, so a provider demoted to paid there stops being called here as well.

Every attempt is stored, failures included, so the database also records which free
models were available at each run. A model whose last three attempts all errored is
skipped, and retried once a day, so the roster's dead weight does not set the run time.

`publish` (daily at 21:30 from the LaunchAgent com.theanhgen.omniroute-haiku-publish, not
cron: cron has no keychain, so neither git nor gh can authenticate there; launchd runs
python3 directly, which may read ~/Desktop) exports the last 14 days to free-models.json,
force-pushes it as the only file on the `bench-data` branch, then starts the Pages deploy
on main (`gh workflow run`), which copies the file in for site/experimental.html. A push
to bench-data can't deploy by itself: the github-pages environment only accepts main. It
commits from a bare repo under ~/Library/Caches, so this working copy, its index and its
branches are never touched. `export PATH` writes the same
JSON locally, for previewing the page.

Stdlib only. Env: OMNIROUTE_BASE_URL, MULTIREVIEW_RUNNER, NODE_BIN, OMNIROUTE_HAIKU_DB,
OMNIROUTE_HAIKU_REMOTE, OMNIROUTE_HAIKU_PUBLISH_REPO.
"""
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPT_FILE = os.path.join(PROJECT_DIR, "scripts", "session_prompt.txt")
DB_PATH = os.environ.get("OMNIROUTE_HAIKU_DB", os.path.join(PROJECT_DIR, "omniroute-haiku.db"))
LOCK_PATH = DB_PATH + ".lock"
BASE_URL = os.environ.get("OMNIROUTE_BASE_URL", "http://localhost:20128/v1").rstrip("/")
RUNNER = os.environ.get("MULTIREVIEW_RUNNER", os.path.expanduser(
    "~/Desktop/bitbybit/00-agent-plugins/marketplaces/local-agents/plugins/"
    "local-agents/scripts/multireview-runner.mjs"))
NODE_BIN = os.environ.get("NODE_BIN", "node")

# Same instruction the three CLI engines get (scripts/generate.sh), so answers compare.
SYSTEM_PROMPT = "Output only the haiku, nothing else. No preamble, no explanation, just three lines."
# Reasoning models spend this budget thinking before the first visible character; the
# multireview runner found 1024 is the floor for a one-word reply, so a haiku gets more.
MAX_TOKENS = 4096
CALL_TIMEOUT_S = 120
# Callers are capped per provider (roster `cap`) and overall. The runner measured 24
# concurrent calls through OmniRoute as clean.
GLOBAL_CONCURRENCY = 24
MAX_RETRIES = 2
# Mistral's free tier allows 2 requests a minute, so its retry waits out the window.
RETRY_WAIT_S = {"mistral": 31}
DEFAULT_RETRY_WAIT_S = 5
RETRYABLE = re.compile(r"\b(429|503)\b|rate.?limit|too many requests|admission", re.I)
# Measured 2026-09-18: 74 of the 82 failures in run 7 came from models that had never
# once answered. Those are skipped after DEAD_AFTER straight errors and retried when their
# last attempt is DEAD_RETRY_HOURS old, which with four runs a day is once a day. A
# malformed reply does not count toward it: the model answered, just not in three lines.
DEAD_AFTER = 3
DEAD_RETRY_HOURS = 20
# OmniRoute serves effort variants as separate ids (gemini-3.7-flash-high); nothing is
# requested on top, so the id is the whole record. Checked before a ":free" tag.
EFFORT_SUFFIX = re.compile(r"-(xhigh|high|medium|low|minimal|none)(?::[\w.-]+)?$")

PUBLISH_BRANCH = "bench-data"
PUBLISH_FILE = "free-models.json"
PUBLISH_REPO = os.environ.get("OMNIROUTE_HAIKU_PUBLISH_REPO", os.path.expanduser(
    "~/Library/Caches/daily-kickstart-bench.git"))
EXPORT_WINDOW_DAYS = 14

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    started_utc TEXT NOT NULL,
    finished_utc TEXT,
    roster_size INTEGER,          -- free models listed, skipped ones included
    ok INTEGER,
    failed INTEGER,
    error TEXT,
    skipped INTEGER               -- listed but not called: errored DEAD_AFTER times running
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    created_utc TEXT NOT NULL,
    model TEXT NOT NULL,          -- id requested from OmniRoute, e.g. cline/z-ai/glm-5.2:free
    provider TEXT NOT NULL,       -- OmniRoute connection the id belongs to, e.g. cline
    served_provider TEXT,         -- x-omniroute-provider: the connection that answered
    served_model TEXT,            -- x-omniroute-model, else the response body's model
    lineage TEXT,                 -- model family per the runner, e.g. gemini, qwen
    effort TEXT,                  -- reasoning effort named by the id, else "default"
    status TEXT NOT NULL,         -- ok | malformed | error
    haiku TEXT,                   -- three lines; only when status = ok
    raw TEXT,                     -- the reply as received, when status = malformed
    error TEXT,
    finish_reason TEXT,
    latency_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    attempts INTEGER NOT NULL,
    request_id TEXT               -- x-omniroute-request-id, to find the call in OmniRoute's logs
);
CREATE INDEX IF NOT EXISTS attempts_run ON attempts(run_id);
CREATE INDEX IF NOT EXISTS attempts_model ON attempts(model);
"""


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    print(f"[{utc_now()} UTC] {msg}", flush=True)


def effort_of(model_id):
    """"high" for agy/gemini-3.7-flash-high; "default" when the id names none."""
    m = EFFORT_SUFFIX.search(model_id)
    return m.group(1) if m else "default"


def load_roster():
    """Free text models, Claude included: lineage independence matters for review, not here.
    --min-ctx 1 drops the image, speech and rerank ids that report no context window."""
    out = subprocess.run(
        [NODE_BIN, RUNNER, "roster", "--same-lineage", "--min-ctx", "1"],
        capture_output=True, text=True, timeout=120, check=False)
    if out.returncode != 0:
        raise RuntimeError(f"roster failed ({out.returncode}): {out.stderr.strip()[:300]}")
    return json.loads(out.stdout)["models"]


THINK_BLOCK = re.compile(r"<think>.*?</think>", re.S | re.I)
FENCE_LINE = re.compile(r"^\s*```")


def clean_haiku(text):
    """Return (haiku, None) for exactly three non-empty lines, else (None, reason).

    Only strips wrappers that are never part of a poem: reasoning blocks and code fences.
    Anything else, a title or a sign-off, fails the three-line check, the same rule
    generate.sh applies to the CLI engines.
    """
    text = THINK_BLOCK.sub("", text or "")
    lines = [ln.strip() for ln in text.splitlines()
             if ln.strip() and not FENCE_LINE.match(ln)]
    if not lines:
        return None, "empty content"
    if len(lines) != 3:
        return None, f"{len(lines)} lines (expected 3)"
    return "\n".join(lines), None


def parse_body(text):
    """(content, body_model, finish_reason, usage) from a JSON or SSE reply.
    Content stays empty for a reply that only carries reasoning: that is not a haiku."""
    if text.lstrip().startswith("data:"):
        content, model, finish, usage = "", None, None, {}
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:") or line == "data: [DONE]":
                continue
            try:
                chunk = json.loads(line[5:].strip())
            except ValueError:
                continue
            model = chunk.get("model") or model
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices") or []:
                content += (choice.get("delta") or {}).get("content") or ""
                finish = choice.get("finish_reason") or finish
        return content, model, finish, usage
    data = json.loads(text)
    if data.get("error") and not data.get("choices"):
        err = data["error"]
        raise ValueError(str(err.get("message", err) if isinstance(err, dict) else err)[:300])
    choices = data.get("choices") or []
    if not choices:
        raise ValueError(f"no choices: {text[:200]}")
    msg = choices[0].get("message") or {}
    return (msg.get("content") or "", data.get("model"),
            choices[0].get("finish_reason"), data.get("usage") or {})


def call_model(entry, system, user):
    quirks = entry.get("quirks") or {}
    body = {
        "model": entry["id"],
        "stream": False,  # OmniRoute streams SSE unless told not to
        "max_tokens": max(MAX_TOKENS, quirks.get("minMaxTokens") or 0),
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        **(quirks.get("body") or {}),
    }
    req = urllib.request.Request(
        f"{BASE_URL}/chat/completions", data=json.dumps(body).encode(),
        headers={"content-type": "application/json"}, method="POST")
    row = {"model": entry["id"], "provider": entry["provider"], "lineage": entry.get("lineage"),
           "effort": effort_of(entry["id"])}
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=CALL_TIMEOUT_S) as resp:
            headers, text = resp.headers, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        with exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
        row.update(status="error", error=f"HTTP {exc.code}: {detail}",
                   request_id=exc.headers.get("x-omniroute-request-id"))
        return row | {"latency_ms": int((time.monotonic() - t0) * 1000)}
    except Exception as exc:  # timeouts, refused connections, resets
        row.update(status="error", error=f"{type(exc).__name__}: {exc}"[:300])
        return row | {"latency_ms": int((time.monotonic() - t0) * 1000)}
    row["latency_ms"] = int((time.monotonic() - t0) * 1000)
    row["served_provider"] = headers.get("x-omniroute-provider")
    row["request_id"] = headers.get("x-omniroute-request-id")
    try:
        content, body_model, finish, usage = parse_body(text)
    except ValueError as exc:
        row.update(status="error", error=str(exc)[:300])
        return row
    row.update(served_model=headers.get("x-omniroute-model") or body_model,
               finish_reason=finish, tokens_in=usage.get("prompt_tokens"),
               tokens_out=usage.get("completion_tokens"))
    haiku, reason = clean_haiku(content)
    if haiku:
        row.update(status="ok", haiku=haiku)
    elif reason == "empty content":
        row.update(status="error", error=f"empty content (finish_reason={finish})")
    else:
        row.update(status="malformed", error=reason, raw=content[:4000])
    return row


def call_with_retry(entry, system, user):
    wait = RETRY_WAIT_S.get(entry["provider"], DEFAULT_RETRY_WAIT_S)
    for attempt in range(1, MAX_RETRIES + 2):
        row = call_model(entry, system, user)
        row["attempts"] = attempt
        if row["status"] != "error" or not RETRYABLE.search(row.get("error") or ""):
            return row
        if attempt <= MAX_RETRIES:
            time.sleep(wait * attempt)
    return row


COLUMNS = ("run_id", "created_utc", "model", "provider", "served_provider", "served_model",
           "lineage", "effort", "status", "haiku", "raw", "error", "finish_reason", "latency_ms",
           "tokens_in", "tokens_out", "attempts", "request_id")


def open_db(path):
    db = sqlite3.connect(path, check_same_thread=False)
    db.executescript(SCHEMA)
    # Columns that arrived after the first runs; CREATE TABLE IF NOT EXISTS adds neither.
    if "skipped" not in {row[1] for row in db.execute("PRAGMA table_info(runs)")}:
        db.execute("ALTER TABLE runs ADD COLUMN skipped INTEGER")
    if "effort" not in {row[1] for row in db.execute("PRAGMA table_info(attempts)")}:
        db.execute("ALTER TABLE attempts ADD COLUMN effort TEXT")
        # Effort comes from the id alone, so older rows can be filled in exactly.
        for (model,) in db.execute("SELECT DISTINCT model FROM attempts").fetchall():
            db.execute("UPDATE attempts SET effort = ? WHERE model = ?", (effort_of(model), model))
        db.commit()
    return db


def split_dead(db, roster, now=None):
    """(to_call, skipped): skipped are models whose last DEAD_AFTER attempts were all
    errors and whose latest attempt is under DEAD_RETRY_HOURS old."""
    now = now or datetime.now(timezone.utc)
    to_call, skipped = [], []
    for entry in roster:
        recent = db.execute(
            "SELECT status, created_utc FROM attempts WHERE model = ? ORDER BY id DESC LIMIT ?",
            (entry["id"], DEAD_AFTER)).fetchall()
        dead = len(recent) == DEAD_AFTER and all(status == "error" for status, _ in recent)
        if dead:
            last = datetime.strptime(recent[0][1], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            if (now - last).total_seconds() < DEAD_RETRY_HOURS * 3600:
                skipped.append(entry)
                continue
        to_call.append(entry)
    return to_call, skipped


def run(roster, db, system, user, skipped=0):
    """Fan the roster out, `cap` workers per provider under one global limit, and store
    each attempt as it finishes so an interrupted run keeps what it already has."""
    run_id = db.execute("INSERT INTO runs (started_utc, roster_size, skipped) VALUES (?, ?, ?)",
                        (utc_now(), len(roster) + skipped, skipped)).lastrowid
    db.commit()
    queues = defaultdict(deque)
    caps = {}
    for entry in roster:
        queues[entry["provider"]].append(entry)
        caps[entry["provider"]] = max(1, int(entry.get("cap") or 1))
    gate = threading.BoundedSemaphore(GLOBAL_CONCURRENCY)
    db_lock = threading.Lock()
    counts = {"ok": 0, "failed": 0}
    failures = defaultdict(int)

    def worker(queue):
        while True:
            try:
                entry = queue.popleft()  # deque.popleft is atomic across threads
            except IndexError:
                return
            with gate:
                try:
                    row = call_with_retry(entry, system, user)
                except Exception as exc:  # a bug must not lose the rest of the provider
                    row = {"model": entry["id"], "provider": entry["provider"],
                           "status": "error", "error": f"{type(exc).__name__}: {exc}"[:300],
                           "attempts": 1}
            row.update(run_id=run_id, created_utc=utc_now())
            with db_lock:
                db.execute(f"INSERT INTO attempts ({', '.join(COLUMNS)}) "
                           f"VALUES ({', '.join('?' for _ in COLUMNS)})",
                           [row.get(c) for c in COLUMNS])
                db.commit()
                if row["status"] == "ok":
                    counts["ok"] += 1
                else:
                    counts["failed"] += 1
                    failures[row["provider"]] += 1  # per-model detail is in the db

    threads = [threading.Thread(target=worker, args=(q,), daemon=True)
               for provider, q in queues.items()
               for _ in range(min(caps[provider], len(q)))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    db.execute("UPDATE runs SET finished_utc = ?, ok = ?, failed = ? WHERE id = ?",
               (utc_now(), counts["ok"], counts["failed"], run_id))
    db.commit()
    return run_id, counts, dict(sorted(failures.items(), key=lambda kv: -kv[1]))


def export(db, now=None, window_days=EXPORT_WINDOW_DAYS, listed=None):
    """What experimental.html shows: the latest finished run's haikus, and how each model
    fared over the window. Nothing internal leaves: no errors, raw replies or request ids.

    `listed` (ids in today's roster) keeps the table to models that still exist: without
    it, the 330 paid nous-research ids a catalog sync let in for a day stay in the window
    for two weeks."""
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(days=window_days)).strftime("%Y-%m-%d %H:%M:%S")
    db.row_factory = sqlite3.Row
    try:
        latest = db.execute(
            "SELECT id, started_utc, roster_size, skipped, ok, failed FROM runs "
            "WHERE finished_utc IS NOT NULL AND error IS NULL ORDER BY id DESC LIMIT 1").fetchone()
        haikus = [] if latest is None else [
            {"model": r["model"], "provider": r["provider"], "effort": r["effort"],
             "lineage": r["lineage"], "served_provider": r["served_provider"],
             "served_model": r["served_model"], "timestamp": f"{r['created_utc']} UTC",
             "lines": r["haiku"].split("\n")}
            for r in db.execute("SELECT * FROM attempts WHERE run_id = ? AND status = 'ok' "
                                "ORDER BY provider, model", (latest["id"],))]
        models = [
            {"model": r["model"], "provider": r["provider"], "effort": r["effort"],
             "lineage": r["lineage"], "asked": r["asked"], "ok": r["ok"],
             "last_ok": f"{r['last_ok']} UTC" if r["last_ok"] else None}
            for r in db.execute(
                "SELECT model, provider, effort, lineage, COUNT(*) AS asked, "
                "SUM(status = 'ok') AS ok, "
                "MAX(CASE WHEN status = 'ok' THEN created_utc END) AS last_ok "
                "FROM attempts WHERE created_utc >= ? GROUP BY model "
                "ORDER BY 1.0 * SUM(status = 'ok') / COUNT(*) DESC, ok DESC, model",
                (since,))
            if listed is None or r["model"] in listed]
        runs = db.execute("SELECT COUNT(*) FROM runs WHERE started_utc >= ? AND error IS NULL",
                          (since,)).fetchone()[0]
    finally:
        db.row_factory = None
    return {
        "generated": now.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "window_days": window_days,
        "runs_in_window": runs,
        "latest_run": None if latest is None else {
            "started": f"{latest['started_utc']} UTC", "listed": latest["roster_size"],
            "skipped": latest["skipped"] or 0, "ok": latest["ok"], "failed": latest["failed"]},
        "haikus": haikus,
        "models": models,
    }


def git(args, stdin=None, cwd=None):
    out = subprocess.run(["git", *args], input=stdin, capture_output=True, text=True,
                         timeout=120, check=False, cwd=cwd)
    if out.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed ({out.returncode}): {out.stderr.strip()[:300]}")
    return out.stdout.strip()


def publish(db, remote=None, repo=PUBLISH_REPO, dispatch=True, listed=None):
    """Force-push free-models.json as the single file of an orphan commit on bench-data.
    No history on purpose: the database is the record, the branch only a transport, and
    a daily snapshot would grow the public repo forever. The refspec is fixed, so this can
    never move any other branch."""
    data = export(db, listed=listed)
    remote = remote or os.environ.get("OMNIROUTE_HAIKU_REMOTE") or git(
        ["-C", PROJECT_DIR, "remote", "get-url", "origin"])
    if not os.path.isdir(repo):
        git(["init", "--bare", "-q", repo])
    blob = git(["-C", repo, "hash-object", "-w", "--stdin"], stdin=json.dumps(data, indent=1))
    tree = git(["-C", repo, "mktree"], stdin=f"100644 blob {blob}\t{PUBLISH_FILE}\n")
    commit = git(["-C", repo, "commit-tree", tree, "-m",
                  f"Free-model bench data, {data['generated']}"])
    git(["-C", repo, "push", "--force", "-q", remote, f"{commit}:refs/heads/{PUBLISH_BRANCH}"])
    if dispatch:
        slug = re.sub(r"^(https://github\.com/|git@github\.com:)|\.git$", "", remote)
        out = subprocess.run(["gh", "workflow", "run", "ci.yml", "--ref", "main", "-R", slug],
                             capture_output=True, text=True, timeout=60, check=False)
        if out.returncode != 0:
            raise RuntimeError(f"pushed {commit[:7]}, but could not start the deploy: "
                               f"{out.stderr.strip()[:300]}")
    return commit, data


def listed_now():
    """Ids in today's roster, or None (no filtering) if the runner can't say."""
    try:
        return {m["id"] for m in load_roster()}
    except Exception as exc:
        log(f"WARNING: roster unavailable, exporting every model in the window: {exc}")
        return None


def main_publish(argv):
    db = open_db(DB_PATH)
    if argv and argv[0] == "export":
        if len(argv) != 2:
            log("usage: omniroute-haiku.py export <path>")
            return 2
        data = export(db, listed=listed_now())
        with open(argv[1], "w") as f:
            json.dump(data, f, indent=1)
        log(f"exported {len(data['haikus'])} haikus, {len(data['models'])} models -> {argv[1]}")
        return 0
    try:
        commit, data = publish(db, listed=listed_now())
    except Exception as exc:
        log(f"ERROR: publish failed: {exc}")
        return 1
    log(f"published {len(data['haikus'])} haikus, {len(data['models'])} models "
        f"to {PUBLISH_BRANCH} ({commit[:7]})")
    return 0


def main():
    if sys.argv[1:2] in (["publish"], ["export"]):
        return main_publish(sys.argv[1:])
    with open(LOCK_PATH, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("ERROR: another omniroute-haiku run is in progress")
            return 1
        with open(PROMPT_FILE) as f:
            user = f.read().strip()
        db = open_db(DB_PATH)
        try:
            roster = load_roster()
        except Exception as exc:
            db.execute("INSERT INTO runs (started_utc, finished_utc, roster_size, error) "
                       "VALUES (?, ?, 0, ?)", (utc_now(), utc_now(), str(exc)[:500]))
            db.commit()
            log(f"ERROR: {exc}")
            return 1
        roster, skipped = split_dead(db, roster)
        log(f"Asking {len(roster)} free models "
            f"across {len({m['provider'] for m in roster})} providers "
            f"(skipping {len(skipped)} that errored {DEAD_AFTER} times running)...")
        run_id, counts, failures = run(roster, db, SYSTEM_PROMPT, user, len(skipped))
        log(f"run {run_id}: {counts['ok']} ok, {counts['failed']} failed -> {DB_PATH}")
        if failures:
            log("failed by provider: " + ", ".join(f"{p} {n}" for p, n in failures.items()))
        return 0 if counts["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
