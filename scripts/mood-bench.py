#!/usr/bin/env python3
"""Score every haiku for mood with TypeSafe's Jev, beside the site's lexicon, and diff them.

A bench, not a site feature: nothing here touches haiku.txt, model.log, haiku.json or the
site. It answers one question before any of that is considered — where does a 70-word
warm/cool word list disagree with a model that reads the whole image?

The lexicon lives in site/main.js (mirrored in site/webmcp.js) and is reimplemented here.
That is a third copy, deliberately: this script must be able to score the archive without a
browser, and a port that drifts shows up immediately as a lexical score this script and the
site disagree on. Keep it in step with MOOD_WARM / MOOD_COOL / MOOD_NEG / MOOD_K over there
if those ever change.

Jev scores 0-4 on the rubric below (cool -> warm) and is rescaled to the lexicon's -1..+1 so
the two are directly comparable. Every answer is cached in SQLite under a hash of the rubric
and the model id: a haiku is never scored twice, and editing RUBRIC or pinning a new model
re-scores on the next run rather than silently rewriting history. The site's mood trend is
permalinked, so if this ever does feed the site, a published score must never move under a
model version bump.

Usage:
    export TYPESAFE_API_KEY=...            # from https://typesafe.ai dashboard
    python3 scripts/mood-bench.py score    # backfill the archive (resumable, cached)
    python3 scripts/mood-bench.py report   # agreement stats + the biggest disagreements
    python3 scripts/mood-bench.py export   # mood-bench.json, for a page or a notebook

Stdlib only. Env: TYPESAFE_API_KEY, TYPESAFE_MODEL, TYPESAFE_BASE_URL, MOOD_BENCH_DB,
MOOD_BENCH_WORKERS, MOOD_BENCH_LIMIT.
"""
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("MOOD_BENCH_DB", os.path.join(PROJECT_DIR, "mood-bench.db"))
SITE_DIR = os.path.join(PROJECT_DIR, "site")
BASE_URL = os.environ.get("TYPESAFE_BASE_URL", "https://api.typesafe.ai").rstrip("/")
MODEL = os.environ.get("TYPESAFE_MODEL", "jev-latest")
WORKERS = int(os.environ.get("MOOD_BENCH_WORKERS", "8"))
TIMEOUT = 30

# ── The question ──────────────────────────────────────────────────────────────
# One dimension, five concrete situations rather than degrees ("mild/strong"), per
# TypeSafe's guidance: the model sees only the descriptions, never their order or
# number, so each has to stand alone. Index 0 is coolest, 4 warmest; QUESTION_NAME
# is the key the answer comes back under.
QUESTION_NAME = "mood"
INSTRUCTIONS = (
    "Read this haiku as a whole image. Where does its feeling sit, from cold and bleak "
    "to warm and bright? Judge the image the words build, not the words alone — "
    "'frost dissolves' is a thaw, and 'blooms like frost' is cold."
)
RUBRIC = [
    "Bleak: loss, absence, or a cold and dark scene with nothing in it that relieves",
    "Subdued: quiet, still, fading or solitary; melancholy, but not despairing",
    "Even: a plain observation, or warmth and cold held in balance with neither winning",
    "Lifting: quiet comfort, a small relief, something opening or beginning to turn",
    "Bright: warmth, arrival, joy, or a difficulty resolving",
]
RUBRIC_HASH = hashlib.sha1(
    (INSTRUCTIONS + "\x00" + "\x00".join(RUBRIC)).encode("utf-8")).hexdigest()[:12]


def jev_to_lexical(score):
    """Rescale Jev's 0..len(RUBRIC)-1 onto the lexicon's -1..+1 so the two compare."""
    return (score / (len(RUBRIC) - 1)) * 2 - 1


# ── Craft questions (the `quality` command) ───────────────────────────────────
# Deliberately NOT one "how good is this haiku" score: that blends meter, imagery,
# cliche and structure into a number you cannot decompose or argue with. These are
# two things a reader can check by eye, composed in code afterwards. Meter is not
# among them — site/main.js already counts syllables deterministically, and a model
# is strictly worse at that than a vowel-group heuristic.
#
# Jev evaluates every question in a call in parallel against the same state and they
# do not see each other's answers (measured: adding these two moves the mood score by
# 0.007 mean, inside its 0.060 noise floor on identical input). So they ride along
# for ~63 input tokens each instead of a second round trip, and change nothing.
CONCRETE = [
    "Pure abstraction or statement; nothing is actually seen",
    "Mostly telling, with a vague gesture at an image",
    "One clear image, but thinly drawn",
    "A specific, particular image you could point at",
    "Several precise details that could only be this one moment",
]
CONCRETE_INSTRUCTIONS = (
    "Does this rest on a specific observed image, or on abstraction and statement?")
TURN_INSTRUCTIONS = (
    "Are two distinct images set against each other, rather than one sentence "
    "broken across three lines?")
QUALITY_HASH = hashlib.sha1(
    (CONCRETE_INSTRUCTIONS + "\x00" + "\x00".join(CONCRETE) + "\x00" + TURN_INSTRUCTIONS)
    .encode("utf-8")).hexdigest()[:12]


# ── The lexicon, ported from site/main.js ─────────────────────────────────────
MOOD_WARM = set((
    "light dawn spring bloom blooms sun warms warm gold golden bright "
    "green coffee wake wakes awakens waking soft softly steam breathes hums opens flows flow "
    "fresh glow blossom cherry hope joy clear gentle alive sunlight daylight").split())
MOOD_COOL = set((
    "silent silence frost snow cold winter empty bare void dark shadow "
    "fade fades falls fall descend descends drift drifts mist night lost alone gray grey still "
    "sleeps sleep fading hollow ash dusk frozen freeze chill barren").split())
MOOD_NEG = set("not no never without nor none cannot".split())
MOOD_K = 2
WORD_RE = re.compile(r"[a-z']+")


def lexical_mood(lines):
    """({score:-1..+1, scored, net}) — the site's moodRaw(), line for line."""
    net = scored = 0
    for line in lines:
        neg_left = 0
        for w in WORD_RE.findall(line.lower()):
            if w in MOOD_NEG:
                neg_left = 3
                continue
            s = 1 if w in MOOD_WARM else -1 if w in MOOD_COOL else 0
            if s:
                net += -s if neg_left > 0 else s
                scored += 1
            if neg_left > 0:
                neg_left -= 1
    return {"score": net / (scored + MOOD_K) if scored else 0.0, "scored": scored, "net": net}


# ── Corpus ────────────────────────────────────────────────────────────────────
def load_haikus():
    """Reuse build-site.py's parser so the bench and the site read haiku.txt identically."""
    path = os.path.join(PROJECT_DIR, "scripts", "build-site.py")
    spec = importlib.util.spec_from_file_location("build_site", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # MOOD_BENCH_HAIKU_FILE scores a haiku.txt other than the working copy's -- e.g.
    # `git show origin/main:haiku.txt`, since the Pi pushes weekly and this checkout lags.
    mod.HAIKU_FILE = os.environ.get("MOOD_BENCH_HAIKU_FILE", mod.HAIKU_FILE)
    return mod.parse_haikus()


# ── Storage ───────────────────────────────────────────────────────────────────
SCHEMA = """
CREATE TABLE IF NOT EXISTS scores (
    timestamp    TEXT NOT NULL,   -- haiku identity: "YYYY-MM-DD HH:MM:SS UTC", unique per entry
    rubric_hash  TEXT NOT NULL,   -- invalidates when INSTRUCTIONS or RUBRIC change
    model        TEXT NOT NULL,   -- as requested; served model is in served_model
    scored_utc   TEXT NOT NULL,
    source       TEXT,            -- engine: claude | codex | agy
    lines        TEXT NOT NULL,
    lex_score    REAL NOT NULL,   -- the site's -1..+1
    lex_scored   INTEGER NOT NULL,-- lexicon words that backed it (its confidence proxy)
    jev_raw      REAL,            -- 0..4 on RUBRIC
    jev_score    REAL,            -- rescaled to -1..+1
    jev_conf     REAL,
    probabilities TEXT,
    served_model TEXT,
    latency_ms   INTEGER,
    error        TEXT,
    PRIMARY KEY (timestamp, rubric_hash, model)
);

CREATE TABLE IF NOT EXISTS quality (
    timestamp     TEXT NOT NULL,
    quality_hash  TEXT NOT NULL,  -- invalidates when either question changes
    model         TEXT NOT NULL,
    scored_utc    TEXT NOT NULL,
    source        TEXT,
    lines         TEXT NOT NULL,
    concrete_raw  REAL,           -- 0..4 on CONCRETE
    concrete_conf REAL,
    turn          REAL,           -- noul, 0..1
    turn_conf     REAL,
    error         TEXT,
    PRIMARY KEY (timestamp, quality_hash, model)
);
"""


def connect():
    # check_same_thread=False: the scoring pool writes from worker threads. Every write is
    # serialised by the caller's lock, so one connection shared across them is safe.
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


# ── API ───────────────────────────────────────────────────────────────────────
def api_key():
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        sys.exit("No TYPESAFE_API_KEY. Get one from the TypeSafe dashboard and export it.")
    return key


def system_one(state, key, questions=None):
    """One POST /v1/systemone. Returns (answers dict, served model, latency ms).

    `questions` defaults to the single mood score. Several questions in one call are
    evaluated in parallel against the same state and cost ~63 input tokens each, against
    a full ~423 for a separate call.
    """
    if questions is None:
        questions = {QUESTION_NAME: {
            "type": "score", "instructions": INSTRUCTIONS, "criteria": RUBRIC}}
    body = json.dumps({
        "state": state,
        "model": MODEL,
        "questions": questions,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/v1/systemone", data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read())
    latency = int((time.monotonic() - t0) * 1000)
    return data["answers"], data.get("model"), latency


def score_cmd():
    key = api_key()
    haikus = load_haikus()
    limit = os.environ.get("MOOD_BENCH_LIMIT")
    conn = connect()
    done = {r[0] for r in conn.execute(
        "SELECT timestamp FROM scores WHERE rubric_hash=? AND model=? AND error IS NULL",
        (RUBRIC_HASH, MODEL))}
    todo = [h for h in haikus if h["timestamp"] not in done]
    if limit:
        todo = todo[:int(limit)]
    print(f"{len(haikus)} haikus, {len(done)} cached, {len(todo)} to score "
          f"(rubric {RUBRIC_HASH}, model {MODEL})")
    if not todo:
        return

    lock = threading.Lock()
    counts = {"ok": 0, "err": 0}

    def one(h):
        state = "\n".join(h["lines"])
        lex = lexical_mood(h["lines"])
        row = {"timestamp": h["timestamp"], "source": h.get("source"),
               "lines": state, "lex_score": lex["score"], "lex_scored": lex["scored"]}
        try:
            answers, served, latency = system_one(state, key)
            ans = answers[QUESTION_NAME]
            row.update(jev_raw=ans["score"], jev_score=jev_to_lexical(ans["score"]),
                       jev_conf=ans.get("confidence"),
                       probabilities=json.dumps(ans.get("probabilities")),
                       served_model=served, latency_ms=latency, error=None)
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode("utf-8", "replace")
            row.update(jev_raw=None, jev_score=None, jev_conf=None, probabilities=None,
                       served_model=None, latency_ms=None, error=f"HTTP {e.code}: {detail}")
        except Exception as e:  # noqa: BLE001 — a bench records the failure, it does not die on it
            row.update(jev_raw=None, jev_score=None, jev_conf=None, probabilities=None,
                       served_model=None, latency_ms=None, error=f"{type(e).__name__}: {e}")
        with lock:
            conn.execute(
                """INSERT OR REPLACE INTO scores (timestamp, rubric_hash, model, scored_utc,
                       source, lines, lex_score, lex_scored, jev_raw, jev_score, jev_conf,
                       probabilities, served_model, latency_ms, error)
                   VALUES (?,?,?,datetime('now'),?,?,?,?,?,?,?,?,?,?,?)""",
                (row["timestamp"], RUBRIC_HASH, MODEL, row["source"], row["lines"],
                 row["lex_score"], row["lex_scored"], row["jev_raw"], row["jev_score"],
                 row["jev_conf"], row["probabilities"], row["served_model"],
                 row["latency_ms"], row["error"]))
            conn.commit()
            counts["err" if row["error"] else "ok"] += 1
            n = counts["ok"] + counts["err"]
            if n % 50 == 0 or n == len(todo):
                print(f"  {n}/{len(todo)}  ok={counts['ok']} err={counts['err']}")

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(one, todo))

    first_err = conn.execute(
        "SELECT error FROM scores WHERE rubric_hash=? AND error IS NOT NULL LIMIT 1",
        (RUBRIC_HASH,)).fetchone()
    if first_err:
        print(f"\nfirst error: {first_err[0]}")
    print(f"\ndone: ok={counts['ok']} err={counts['err']} -> {DB_PATH}")


# ── Report ────────────────────────────────────────────────────────────────────
def rows_for_report(conn):
    return conn.execute(
        """SELECT * FROM scores WHERE rubric_hash=? AND model=? AND error IS NULL
           ORDER BY timestamp""", (RUBRIC_HASH, MODEL)).fetchall()


def pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return float("nan")
    mx, my = statistics.mean(xs), statistics.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
    return num / den if den else float("nan")


def label(score, ci=0.0):
    """The site's warm/cool/even deadband, applied to a single score."""
    return "warm" if score - ci > 0.03 else "cool" if score + ci < -0.03 else "even"


def report_cmd():
    conn = connect()
    rows = rows_for_report(conn)
    if not rows:
        sys.exit(f"Nothing scored for rubric {RUBRIC_HASH} / model {MODEL}. Run `score` first.")
    lex = [r["lex_score"] for r in rows]
    jev = [r["jev_score"] for r in rows]
    conf = [r["jev_conf"] for r in rows if r["jev_conf"] is not None]
    lat = [r["latency_ms"] for r in rows if r["latency_ms"] is not None]

    print(f"n={len(rows)}  rubric={RUBRIC_HASH}  model={MODEL}\n")
    print(f"  lexical   mean {statistics.mean(lex):+.3f}  sd {statistics.pstdev(lex):.3f}")
    print(f"  jev       mean {statistics.mean(jev):+.3f}  sd {statistics.pstdev(jev):.3f}")
    print(f"  pearson r {pearson(lex, jev):.3f}")
    if conf:
        print(f"  jev confidence  mean {statistics.mean(conf):.3f}  "
              f"min {min(conf):.3f}  max {max(conf):.3f}")
    if lat:
        lat.sort()
        print(f"  latency  p50 {lat[len(lat)//2]}ms  p95 {lat[int(len(lat)*0.95)]}ms")

    agree = sum(1 for r in rows if label(r["lex_score"]) == label(r["jev_score"]))
    print(f"\n  same warm/cool/even label: {agree}/{len(rows)} ({100*agree/len(rows):.1f}%)")

    flat = [r for r in rows if r["lex_score"] == 0.0]
    if flat:
        moved = [r for r in flat if label(r["jev_score"]) != "even"]
        print(f"  lexicon said exactly 0.00: {len(flat)}"
              f" — jev calls {len(moved)} of them warm or cool ({100*len(moved)/len(flat):.0f}%)")

    print("\n### Biggest disagreements")
    for r in sorted(rows, key=lambda r: -abs(r["lex_score"] - r["jev_score"]))[:15]:
        d = r["jev_score"] - r["lex_score"]
        print(f"  lex {r['lex_score']:+.2f} ({r['lex_scored']}w)  jev {r['jev_score']:+.2f}"
              f" conf {r['jev_conf']:.2f}  Δ{d:+.2f}  [{r['source']}]")
        print(f"      {' / '.join(r['lines'].splitlines())}")

    print("\n### Where jev is least sure")
    for r in sorted(rows, key=lambda r: r["jev_conf"] or 1)[:5]:
        print(f"  conf {r['jev_conf']:.2f}  jev {r['jev_score']:+.2f}  lex {r['lex_score']:+.2f}"
              f"  {' / '.join(r['lines'].splitlines())}")


def export_cmd():
    """Write site/mood-bench.json: the page payload, not the raw table.

    The site gets a summary plus the haikus that carry the story, not all 1,933 rows —
    the page is an argument about where the two methods part, and a scatter of every
    haiku would be a bigger download that says less. The raw data stays in SQLite.

    Committed to main rather than pushed through the bench-data branch: that pipeline
    exists because the free-model bench refreshes daily, and this is a snapshot of a
    fixed archive scored once.
    """
    conn = connect()
    rows = rows_for_report(conn)
    if not rows:
        sys.exit(f"Nothing scored for rubric {RUBRIC_HASH}. Run `score` first.")

    lex = [r["lex_score"] for r in rows]
    jev = [r["jev_score"] for r in rows]
    conf = [r["jev_conf"] for r in rows if r["jev_conf"] is not None]
    lat = sorted(r["latency_ms"] for r in rows if r["latency_ms"] is not None)
    flat = [r for r in rows if r["lex_score"] == 0.0]
    moved = [r for r in flat if label(r["jev_score"]) != "even"]
    agree = sum(1 for r in rows if label(r["lex_score"]) == label(r["jev_score"]))

    def item(r):
        return {"lines": r["lines"].splitlines(), "source": r["source"],
                "lex": round(r["lex_score"], 3), "jev": round(r["jev_score"], 3),
                "conf": round(r["jev_conf"], 3) if r["jev_conf"] is not None else None,
                "lex_scored": r["lex_scored"]}

    ranked = sorted(rows, key=lambda r: -abs(r["lex_score"] - r["jev_score"]))
    payload = {
        "generated": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "model": MODEL,
        "rubric_hash": RUBRIC_HASH,
        "legend": RUBRIC,
        "n": len(rows),
        "summary": {
            "agree": agree,
            "agree_pct": round(100 * agree / len(rows), 1),
            "r": round(pearson(lex, jev), 3),
            "lex_mean": round(statistics.mean(lex), 3),
            "jev_mean": round(statistics.mean(jev), 3),
            "conf_mean": round(statistics.mean(conf), 3) if conf else None,
            "flat_n": len(flat),
            "flat_moved": len(moved),
            "latency_p50": lat[len(lat) // 2] if lat else None,
        },
        # Both directions: the lexicon reading a thaw as cold, and reading an elegy as warm.
        "jev_warmer": [item(r) for r in ranked if r["jev_score"] > r["lex_score"]][:12],
        "jev_cooler": [item(r) for r in ranked if r["jev_score"] < r["lex_score"]][:12],
        "unsure": [item(r) for r in sorted(rows, key=lambda r: r["jev_conf"] or 1)[:6]],
    }
    out = os.path.join(SITE_DIR, "mood-bench.json")
    with open(out, "w") as f:
        json.dump(payload, f, indent=1)
    print(f"wrote {out}  ({os.path.getsize(out) // 1024} KB, {len(rows)} scored, "
          f"{len(payload['jev_warmer']) + len(payload['jev_cooler'])} shown)")

    # Every scored haiku, keyed by the timestamp haiku.json carries, for the archive's
    # Sentiment toggle. `through` is the newest haiku scored: anything written after it
    # has no model score, and the chart ends the model's lines there rather than
    # pretending. Compact separators; this one ships to every archive visitor.
    jev_map = {
        "model": MODEL,
        "rubric_hash": RUBRIC_HASH,
        "through": max(r["timestamp"] for r in rows),
        "scores": {r["timestamp"]: round(r["jev_score"], 3) for r in rows},
    }
    out = os.path.join(SITE_DIR, "mood-jev.json")
    with open(out, "w") as f:
        json.dump(jev_map, f, separators=(",", ":"))
    print(f"wrote {out}  ({os.path.getsize(out) // 1024} KB, through {jev_map['through']})")



# ── Craft scoring ─────────────────────────────────────────────────────────────
def quality_cmd():
    """Score concrete + turn for every haiku, both questions in one call."""
    key = api_key()
    haikus = load_haikus()
    limit = os.environ.get("MOOD_BENCH_LIMIT")
    conn = connect()
    done = {r[0] for r in conn.execute(
        "SELECT timestamp FROM quality WHERE quality_hash=? AND model=? AND error IS NULL",
        (QUALITY_HASH, MODEL))}
    todo = [h for h in haikus if h["timestamp"] not in done]
    if limit:
        todo = todo[:int(limit)]
    print(f"{len(haikus)} haikus, {len(done)} cached, {len(todo)} to score "
          f"(quality {QUALITY_HASH}, model {MODEL})")
    if not todo:
        return

    questions = {
        "concrete": {"type": "score", "instructions": CONCRETE_INSTRUCTIONS,
                     "criteria": CONCRETE},
        "turn": {"type": "noul", "instructions": TURN_INSTRUCTIONS},
    }
    lock = threading.Lock()
    counts = {"ok": 0, "err": 0}

    def one(h):
        state = "\n".join(h["lines"])
        row = {"timestamp": h["timestamp"], "source": h.get("source"), "lines": state}
        try:
            answers, _served, _lat = system_one(state, key, questions)
            c, t = answers["concrete"], answers["turn"]
            row.update(concrete_raw=c["score"], concrete_conf=c.get("confidence"),
                       turn=t["noul"], turn_conf=t.get("confidence"), error=None)
        except Exception as e:  # noqa: BLE001 — a bench records the failure, it does not die
            row.update(concrete_raw=None, concrete_conf=None, turn=None, turn_conf=None,
                       error=f"{type(e).__name__}: {e}"[:200])
        with lock:
            conn.execute(
                """INSERT OR REPLACE INTO quality (timestamp, quality_hash, model,
                       scored_utc, source, lines, concrete_raw, concrete_conf, turn,
                       turn_conf, error)
                   VALUES (?,?,?,datetime('now'),?,?,?,?,?,?,?)""",
                (row["timestamp"], QUALITY_HASH, MODEL, row["source"], row["lines"],
                 row["concrete_raw"], row["concrete_conf"], row["turn"],
                 row["turn_conf"], row["error"]))
            conn.commit()
            counts["err" if row["error"] else "ok"] += 1
            n = counts["ok"] + counts["err"]
            if n % 100 == 0 or n == len(todo):
                print(f"  {n}/{len(todo)}  ok={counts['ok']} err={counts['err']}")

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(one, todo))
    print(f"\ndone: ok={counts['ok']} err={counts['err']} -> {DB_PATH}")


def leaderboard_cmd():
    """Per-engine craft summary. Composed here, not asked for as one number.

    Read it with the confidence column in hand: Jev is markedly less sure about
    `concrete` (0.49-0.67) than about mood (0.79), and the engine spread is narrow,
    so the ordering is not a ranking. `distinct` is the column that separates them,
    and it costs no model call at all.
    """
    conn = connect()
    rows = conn.execute(
        """SELECT * FROM quality WHERE quality_hash=? AND model=? AND error IS NULL""",
        (QUALITY_HASH, MODEL)).fetchall()
    if not rows:
        sys.exit(f"Nothing scored for quality {QUALITY_HASH}. Run `quality` first.")

    def norm(lines):
        return " / ".join(l.lower().strip() for l in lines.splitlines())

    print(f"n={len(rows)}  quality={QUALITY_HASH}  model={MODEL}")
    print(f"  concrete 0-4 (higher = more particular), turn 0-1 (two images vs one sentence)\n")
    by = {}
    for r in rows:
        by.setdefault(r["source"] or "untagged", []).append(r)
    hdr = f"  {'engine':10} {'n':>5} {'concrete':>9} {'turn':>7} {'conf':>6} {'distinct':>9}"
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    out = []
    for src, rs in by.items():
        conc = statistics.mean(r["concrete_raw"] for r in rs)
        turn = statistics.mean(r["turn"] for r in rs)
        conf = statistics.mean(r["concrete_conf"] for r in rs if r["concrete_conf"] is not None)
        distinct = len({norm(r["lines"]) for r in rs}) / len(rs)
        out.append((conc, src, len(rs), conc, turn, conf, distinct))
    for _, src, n, conc, turn, conf, distinct in sorted(out, reverse=True):
        print(f"  {src:10} {n:5d} {conc:9.2f} {turn:7.2f} {conf:6.2f} {100*distinct:8.1f}%")

    print("\n### Most particular")
    for r in sorted(rows, key=lambda r: -r["concrete_raw"])[:4]:
        print(f"  concrete {r['concrete_raw']:.2f} turn {r['turn']:.2f} [{r['source']}]"
              f"  {' / '.join(r['lines'].splitlines())}")
    print("\n### Most abstract")
    for r in sorted(rows, key=lambda r: r["concrete_raw"])[:4]:
        print(f"  concrete {r['concrete_raw']:.2f} turn {r['turn']:.2f} [{r['source']}]"
              f"  {' / '.join(r['lines'].splitlines())}")



# ── Blind labelling ───────────────────────────────────────────────────────────
# The only thing in this bench that produces ground truth. Everything else measures
# whether the lexicon and Jev *agree*; this measures which one agrees with the reader.
#
# Two rules keep it fair. The sheet carries a neutral -10..+10 anchor, never RUBRIC's
# wording: handing the reader Jev's own level descriptions would teach them Jev's
# scale and hand it the win. And the sample is stratified by |lex - jev| with the
# agreement band included as a control, then shuffled under a fixed seed, so the
# strata are not guessable from the order.
BLIND_SHEET = os.path.join(PROJECT_DIR, "blind-sheet.txt")
BLIND_KEY = os.path.join(PROJECT_DIR, "blind-key.json")
BLIND_SEED = 20260920
STRATA = [("disagree", 0.50, 9.99, 20), ("middle", 0.20, 0.50, 20), ("agree", 0.0, 0.20, 20)]

SHEET_HEADER = """\
# Blind mood labelling — {n} haikus
#
# For each haiku, replace the _ after "score =" with a whole number, -10 to +10:
#
#   -10  = coldest, bleakest
#    0   = neither warm nor cold
#   +10  = warmest, brightest
#
# Whole numbers, no decimals needed. Use the whole range -- if everything lands
# between -3 and +3 the comparison has nothing to work with.
#
# Judge the feeling of the whole image. There is no right answer and nothing is
# being tested except which of two scoring methods agrees with you. Do not look
# anything up, do not go back and adjust for consistency, and leave a haiku blank
# if you genuinely cannot decide.
#
# Save the file when done, then run:  python3 scripts/mood-bench.py blind-score
"""


def blind_cmd():
    """Write a stratified, shuffled, unlabelled sheet plus its hidden answer key.

    Refuses to overwrite a sheet that already carries answers: regenerating destroys
    the reader's work silently, and the sheet is the one artefact here that cannot be
    recomputed. MOOD_BENCH_FORCE=1 overrides.
    """
    import random
    if os.path.exists(BLIND_SHEET) and not os.environ.get("MOOD_BENCH_FORCE"):
        filled = sum(1 for l in open(BLIND_SHEET)
                     if l.startswith("score =") and l.split("=", 1)[1].strip() not in ("_", ""))
        if filled:
            sys.exit(f"{BLIND_SHEET} already has {filled} answers in it. "
                     f"Regenerating would erase them.\n"
                     f"Score it with `blind-score`, or re-run with MOOD_BENCH_FORCE=1 "
                     f"to start over.")
    conn = connect()
    rows = conn.execute(
        """SELECT timestamp, lines, lex_score, jev_score FROM scores
           WHERE rubric_hash=? AND model=? AND error IS NULL""",
        (RUBRIC_HASH, MODEL)).fetchall()
    if not rows:
        sys.exit("Nothing scored. Run `score` first.")

    rng = random.Random(BLIND_SEED)
    # One haiku per distinct text: near-duplicates would ask the reader the same
    # question repeatedly and inflate whichever method happens to suit that poem.
    seen, pool = set(), []
    for r in rows:
        if r["lines"] not in seen:
            seen.add(r["lines"])
            pool.append(r)

    picked = []
    for name, lo, hi, want in STRATA:
        band = [r for r in pool if lo <= abs(r["lex_score"] - r["jev_score"]) < hi]
        rng.shuffle(band)
        chosen = band[:want]
        picked += [(name, r) for r in chosen]
        print(f"  {name:9} |lex-jev| {lo:.2f}-{hi:.2f}: {len(chosen)} of {len(band)} available")

    rng.shuffle(picked)
    key = []
    with open(BLIND_SHEET, "w") as f:
        f.write(SHEET_HEADER.format(n=len(picked)))
        for i, (stratum, r) in enumerate(picked, 1):
            f.write(f"\n### {i}\n")
            for line in r["lines"].splitlines():
                f.write(line + "\n")
            f.write("score = _\n")
            key.append({"i": i, "stratum": stratum, "timestamp": r["timestamp"],
                        "lex": r["lex_score"], "jev": r["jev_score"]})
    with open(BLIND_KEY, "w") as f:
        json.dump({"seed": BLIND_SEED, "rubric_hash": RUBRIC_HASH, "items": key}, f, indent=1)
    print(f"\nwrote {len(picked)} haikus -> {BLIND_SHEET}")
    print(f"answer key (do not read before labelling) -> {BLIND_KEY}")


def blind_score_cmd():
    """Correlate the reader's labels against both methods."""
    if not os.path.exists(BLIND_KEY):
        sys.exit("No key. Run `blind` first.")
    key = json.load(open(BLIND_KEY))
    by_i = {k["i"]: k for k in key["items"]}

    labels, cur = {}, None
    for line in open(BLIND_SHEET):
        line = line.strip()
        m = re.match(r"^### (\d+)$", line)
        if m:
            cur = int(m.group(1))
        elif line.startswith("score =") and cur is not None:
            v = line.split("=", 1)[1].strip().lstrip("+")
            try:
                f = float(v)
            except ValueError:
                continue
            if -10.0 <= f <= 10.0:     # /10 -> the lexicon's -1..+1 space
                labels[cur] = f / 10.0
    if not labels:
        sys.exit(f"No labels found in {BLIND_SHEET}.\n"
                 f"Replace each `score = _` with a whole number -10..+10, then save.")

    def block(name, items):
        if len(items) < 3:
            return
        human = [labels[i] for i in items]
        lex = [by_i[i]["lex"] for i in items]
        jev = [by_i[i]["jev"] for i in items]
        r_lex, r_jev = pearson(lex, human), pearson(jev, human)
        mae_lex = statistics.mean(abs(a - b) for a, b in zip(lex, human))
        mae_jev = statistics.mean(abs(a - b) for a, b in zip(jev, human))
        win = "jev" if r_jev > r_lex else "lexicon" if r_lex > r_jev else "tie"
        print(f"  {name:10} n={len(items):3d}   r(lex)={r_lex:+.3f}  r(jev)={r_jev:+.3f}"
              f"   MAE lex={mae_lex:.3f} jev={mae_jev:.3f}   -> {win}")

    print(f"labelled {len(labels)}/{len(by_i)}\n")
    print("  correlation with the reader (higher r = closer; MAE lower = closer)")
    block("ALL", sorted(labels))
    for name, _lo, _hi, _n in STRATA:
        block(name, sorted(i for i in labels if by_i[i]["stratum"] == name))
    print("\n  The `agree` band is the control: both methods should score alike there.")
    print("  The verdict lives in `disagree`.")


COMMANDS = {"score": score_cmd, "blind": blind_cmd, "blind-score": blind_score_cmd, "quality": quality_cmd, "leaderboard": leaderboard_cmd, "report": report_cmd, "export": export_cmd}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "score"
    if cmd not in COMMANDS:
        sys.exit(f"usage: mood-bench.py [{'|'.join(COMMANDS)}]")
    COMMANDS[cmd]()
