#!/usr/bin/env python3
"""Unit tests for scripts/omniroute-haiku.py, against a stub OmniRoute (no real calls)."""
import importlib.util
import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "omniroute_haiku", os.path.join(REPO_DIR, "scripts", "omniroute-haiku.py"))
oh = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(oh)

HAIKU = "Old pond at dawn\nA frog leaps into the hush\nRipples find the shore"

# model id -> (status, headers, body). Bodies are what the stub returns verbatim.
REPLIES = {
    "good/model": (200, {"x-omniroute-provider": "good-conn", "x-omniroute-model": "model-v2",
                         "x-omniroute-request-id": "req-1"},
                   {"model": "body-model", "choices": [{"finish_reason": "stop",
                    "message": {"content": f"<think>count syllables</think>\n```\n{HAIKU}\n```"}}],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 20}}),
    "chatty/model": (200, {}, {"choices": [{"finish_reason": "stop",
                     "message": {"content": f"Here is a haiku:\n{HAIKU}"}}]}),
    "thinker/model": (200, {}, {"choices": [{"finish_reason": "length",
                      "message": {"content": "", "reasoning": "hmm..."}}]}),
    "broken/model": (502, {"x-omniroute-request-id": "req-9"}, {"error": {"message": "upstream"}}),
}


class Stub(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        Stub.seen.append(body)
        status, headers, reply = REPLIES[body["model"]]
        payload = json.dumps(reply).encode()
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class CleanHaikuTest(unittest.TestCase):
    def test_strips_reasoning_and_fences(self):
        self.assertEqual(oh.clean_haiku(f"<think>a\nb</think>```text\n{HAIKU}\n```"), (HAIKU, None))

    def test_extra_line_is_malformed_not_trimmed(self):
        self.assertEqual(oh.clean_haiku(f"Title\n{HAIKU}"), (None, "4 lines (expected 3)"))

    def test_empty(self):
        self.assertEqual(oh.clean_haiku("<think>only thoughts</think>"), (None, "empty content"))

    def test_sse_body(self):
        chunks = [{"model": "m", "choices": [{"delta": {"content": "a\nb"}}]},
                  {"choices": [{"delta": {"content": "\nc"}, "finish_reason": "stop"}]}]
        text = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n"
        self.assertEqual(oh.parse_body(text), ("a\nb\nc", "m", "stop", {}))


class RunTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.orig = (oh.BASE_URL, oh.DEFAULT_RETRY_WAIT_S)
        oh.BASE_URL = f"http://127.0.0.1:{self.server.server_port}/v1"
        oh.DEFAULT_RETRY_WAIT_S = 0
        self.tmp = tempfile.TemporaryDirectory()
        self.db = oh.open_db(os.path.join(self.tmp.name, "h.db"))
        Stub.seen = []

    def tearDown(self):
        oh.BASE_URL, oh.DEFAULT_RETRY_WAIT_S = self.orig
        self.server.shutdown()
        self.server.server_close()
        self.db.close()
        self.tmp.cleanup()

    def test_every_attempt_is_stored_with_model_and_provider(self):
        roster = [
            {"id": "good/model", "provider": "good", "lineage": "gemini", "cap": 2,
             "quirks": {"body": {"tags": ["user=x"]}, "minMaxTokens": 256}},
            {"id": "chatty/model", "provider": "chatty", "cap": 1},
            {"id": "thinker/model", "provider": "thinker", "cap": 1},
            {"id": "broken/model", "provider": "broken", "cap": 1},
        ]
        run_id, counts, failures = oh.run(roster, self.db, "sys", "Generate a haiku.")
        self.assertEqual(counts, {"ok": 1, "failed": 3})
        self.assertEqual(failures, {"chatty": 1, "thinker": 1, "broken": 1})
        self.db.row_factory = sqlite3.Row
        rows = {r["model"]: r for r in self.db.execute("SELECT * FROM attempts WHERE run_id = ?", (run_id,))}

        good = rows["good/model"]
        self.assertEqual((good["status"], good["haiku"]), ("ok", HAIKU))
        self.assertEqual((good["provider"], good["served_provider"], good["served_model"]),
                         ("good", "good-conn", "model-v2"))
        self.assertEqual((good["tokens_in"], good["tokens_out"], good["request_id"]), (30, 20, "req-1"))

        chatty = rows["chatty/model"]
        self.assertEqual((chatty["status"], chatty["haiku"]), ("malformed", None))
        self.assertIn("Here is a haiku", chatty["raw"])

        # A reasoning-only reply is a failure, never a haiku made of its thoughts.
        self.assertEqual(rows["thinker/model"]["status"], "error")
        self.assertIn("finish_reason=length", rows["thinker/model"]["error"])

        broken = rows["broken/model"]
        self.assertEqual((broken["status"], broken["request_id"]), ("error", "req-9"))
        self.assertTrue(broken["error"].startswith("HTTP 502"))
        self.assertEqual(broken["attempts"], 1)  # 502 is not a retryable status

        run = self.db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        self.assertEqual((run["roster_size"], run["ok"], run["failed"], run["skipped"]), (4, 1, 3, 0))
        self.assertIsNotNone(run["finished_utc"])

        sent = next(b for b in Stub.seen if b["model"] == "good/model")
        self.assertEqual((sent["tags"], sent["max_tokens"], sent["stream"]), (["user=x"], 4096, False))
        self.assertEqual(good["effort"], "default")
        self.assertEqual(sent["messages"][1]["content"], "Generate a haiku.")

    def test_rate_limit_is_retried(self):
        REPLIES["limited/model"] = (429, {}, {"error": {"message": "rate limited"}})
        try:
            oh.run([{"id": "limited/model", "provider": "limited", "cap": 1}], self.db, "s", "u")
        finally:
            del REPLIES["limited/model"]
        attempts = self.db.execute("SELECT attempts FROM attempts").fetchone()[0]
        self.assertEqual(attempts, oh.MAX_RETRIES + 1)


class SplitDeadTest(unittest.TestCase):
    NOW = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = oh.open_db(os.path.join(self.tmp.name, "h.db"))

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def history(self, model, *attempts):
        """attempts oldest first, as (status, hours_before_NOW)."""
        for status, hours_ago in attempts:
            ts = (self.NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%d %H:%M:%S")
            self.db.execute("INSERT INTO attempts (run_id, created_utc, model, provider, status, "
                            "attempts) VALUES (1, ?, ?, 'p', ?, 1)", (ts, model, status))

    def test_split(self):
        self.history("dead/recent", ("ok", 30), ("error", 15), ("error", 10), ("error", 5))
        self.history("dead/stale", ("error", 30), ("error", 25), ("error", 21))
        self.history("two/errors", ("error", 10), ("error", 5))
        self.history("malformed/among", ("error", 15), ("malformed", 10), ("error", 5))
        self.history("revived", ("error", 15), ("error", 10), ("ok", 5))
        roster = [{"id": m} for m in ("dead/recent", "dead/stale", "two/errors",
                                      "malformed/among", "revived", "brand/new")]
        to_call, skipped = oh.split_dead(self.db, roster, now=self.NOW)
        self.assertEqual([e["id"] for e in skipped], ["dead/recent"])
        self.assertEqual([e["id"] for e in to_call],
                         ["dead/stale", "two/errors", "malformed/among", "revived", "brand/new"])

    def test_old_db_gains_skipped_column(self):
        path = os.path.join(self.tmp.name, "old.db")
        old = sqlite3.connect(path)
        old.execute("CREATE TABLE runs (id INTEGER PRIMARY KEY, started_utc TEXT NOT NULL, "
                    "finished_utc TEXT, roster_size INTEGER, ok INTEGER, failed INTEGER, error TEXT)")
        old.commit()
        old.close()
        db = oh.open_db(path)
        self.assertIn("skipped", {row[1] for row in db.execute("PRAGMA table_info(runs)")})
        db.close()


class EffortTest(unittest.TestCase):
    def test_effort_of(self):
        self.assertEqual(oh.effort_of("agy/gemini-3.7-flash-high"), "high")
        self.assertEqual(oh.effort_of("agy/gpt-oss-120b-medium"), "medium")
        self.assertEqual(oh.effort_of("x/model-xhigh:free"), "xhigh")
        self.assertEqual(oh.effort_of("agy/gemini-3.7-flash-tiered"), "default")
        self.assertEqual(oh.effort_of("cline/z-ai/glm-5.2:free"), "default")

    def test_old_rows_are_backfilled(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "old.db")
            old = sqlite3.connect(path)
            old.execute("CREATE TABLE attempts (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, "
                        "created_utc TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, "
                        "status TEXT NOT NULL, attempts INTEGER NOT NULL)")
            old.execute("INSERT INTO attempts (run_id, created_utc, model, provider, status, attempts) "
                        "VALUES (1, '2026-09-17 10:00:00', 'agy/gemini-3.6-flash-low', 'agy', 'ok', 1)")
            old.commit()
            old.close()
            db = oh.open_db(path)
            self.assertEqual(db.execute("SELECT effort FROM attempts").fetchone()[0], "low")
            db.close()


class ExportPublishTest(unittest.TestCase):
    NOW = datetime(2026, 9, 18, 20, 0, tzinfo=timezone.utc)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = oh.open_db(os.path.join(self.tmp.name, "h.db"))
        for rid, started, err in ((1, "2026-09-01 06:00:00", None), (2, "2026-09-18 06:00:00", None),
                                  (3, "2026-09-18 11:00:00", "roster failed")):
            self.db.execute("INSERT INTO runs (id, started_utc, finished_utc, roster_size, skipped, ok, "
                            "failed, error) VALUES (?, ?, ?, 3, 1, 1, 1, ?)", (rid, started, started, err))
        rows = [
            (1, "2026-09-01 06:01:00", "a/old", "error", None),       # outside the window
            (2, "2026-09-18 06:01:00", "agy/m-high", "ok", "one\ntwo\nthree"),
            (2, "2026-09-18 06:01:00", "b/dead", "error", None),
        ]
        for rid, ts, model, status, haiku in rows:
            self.db.execute("INSERT INTO attempts (run_id, created_utc, model, provider, effort, status, "
                            "haiku, error, request_id, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 'boom', 'req', 1)",
                            (rid, ts, model, model.split("/")[0], oh.effort_of(model), status, haiku))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_export_shape(self):
        data = oh.export(self.db, now=self.NOW)
        # The failed-roster run 3 is not "latest": it wrote no attempts.
        self.assertEqual(data["latest_run"]["started"], "2026-09-18 06:00:00 UTC")
        self.assertEqual([(h["model"], h["effort"], h["lines"]) for h in data["haikus"]],
                         [("agy/m-high", "high", ["one", "two", "three"])])
        self.assertEqual([(m["model"], m["asked"], m["ok"]) for m in data["models"]],
                         [("agy/m-high", 1, 1), ("b/dead", 1, 0)])
        self.assertEqual(data["runs_in_window"], 1)
        self.assertEqual(data["cloud"]["haikus"], 1)
        # Only models still in the roster, when the caller knows the roster.
        self.assertEqual([m["model"] for m in oh.export(self.db, now=self.NOW, listed={"agy/m-high"})["models"]],
                         ["agy/m-high"])
        blob = json.dumps(data)
        for private in ("boom", "req"):   # errors and request ids stay on the Mac
            self.assertNotIn(f'"{private}"', blob)

    def test_publish_force_pushes_one_file_to_bench_data(self):
        remote = os.path.join(self.tmp.name, "remote.git")
        subprocess.run(["git", "init", "--bare", "-q", remote], check=True)
        repo = os.path.join(self.tmp.name, "publish.git")
        env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t"}
        old_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            first, _ = oh.publish(self.db, remote=remote, repo=repo, dispatch=False)
            second, _ = oh.publish(self.db, remote=remote, repo=repo, dispatch=False)
        finally:
            for k, v in old_env.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
        git = lambda *a: subprocess.run(["git", "-C", remote, *a], capture_output=True, text=True,
                                        check=True).stdout.strip()
        self.assertEqual(git("rev-parse", "refs/heads/bench-data"), second)
        self.assertEqual(git("ls-tree", "--name-only", "bench-data"), "free-models.json")
        self.assertEqual(git("rev-list", "--count", "bench-data"), "1")   # orphan, no history
        self.assertEqual(git("for-each-ref", "--format=%(refname)"), "refs/heads/bench-data")
        self.assertIn("agy/m-high", git("show", "bench-data:free-models.json"))


class WordCloudTest(unittest.TestCase):
    def test_counts_use_the_archive_tokenizer(self):
        self.assertEqual(oh.cloud_words(["The moon's glow, a pond", "An old frog in it"]),
                         ["moon's", "glow", "pond", "old", "frog"])

    def test_ownership_needs_share_and_lift(self):
        # Word totals: gemini 12, mistral 8, qwen 6 (46% / 31% / 23%).
        haikus = ([("g/1", "gemini", ["silence river stone"])] * 4
                  + [("q/1", "qwen", ["silence plum plum"])] * 2
                  + [("m/1", "mistral", ["silence river"])] * 4)
        words = {w["word"]: w for w in oh.word_cloud(haikus)}
        self.assertEqual(words["silence"]["owner"], None)        # everyone's word
        self.assertEqual(words["plum"]["owner"], "qwen")         # all qwen, 4x its share
        self.assertEqual(words["stone"]["owner"], "gemini")      # all gemini, 2.2x its share
        # An even split still leans: river is half of each, but mistral writes less
        # overall (1.6x its share) while gemini's half is just its share (1.1x).
        self.assertEqual(words["river"]["owner"], "mistral")
        self.assertEqual(words["silence"]["uses"], 10)
        self.assertEqual(words["silence"]["models"], 3)
        self.assertEqual(words["silence"]["families"][0], ["gemini", 4])
        self.assertEqual(list(words)[0], "silence")              # most-used first

    def test_rare_words_are_dropped(self):
        self.assertEqual(oh.word_cloud([("a/1", "gemini", ["lonely heron"])] * 2), [])


if __name__ == "__main__":
    unittest.main()
