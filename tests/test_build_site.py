#!/usr/bin/env python3
"""Unit tests for scripts/build-site.py (parser, slug, insight)."""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "build_site", os.path.join(REPO_DIR, "scripts", "build-site.py"))
bs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bs)


def parse(text):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text)
        path = f.name
    orig = bs.HAIKU_FILE
    bs.HAIKU_FILE = path
    try:
        return bs.parse_haikus()
    finally:
        bs.HAIKU_FILE = orig
        os.unlink(path)


class ParseHaikusTest(unittest.TestCase):
    def test_normal_entries_newest_first(self):
        out = parse(
            "2026-06-01 06:00:01 UTC [claude]\n"
            "one\ntwo\nthree\n"
            "\n"
            "2026-06-01 06:00:09 UTC [codex]\n"
            "four\nfive\nsix\n"
        )
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["source"], "codex")          # newest first
        self.assertEqual(out[0]["lines"], ["four", "five", "six"])
        self.assertEqual(out[1]["timestamp"], "2026-06-01 06:00:01 UTC")

    def test_short_entry_does_not_swallow_next_header(self):
        out = parse(
            "2026-06-01 06:00:01 UTC [claude]\n"
            "only\ntwo lines\n"
            "\n"
            "2026-06-01 06:00:09 UTC [codex]\n"
            "four\nfive\nsix\n"
        )
        self.assertEqual(len(out), 1)                        # short one dropped alone
        self.assertEqual(out[0]["source"], "codex")

    def test_pre_engine_tagging_attributed_to_claude(self):
        out = parse(
            "2026-04-01 06:00:01 UTC\n"
            "one\ntwo\nthree\n"
            "\n"
            "2026-05-01 06:00:01 UTC\n"
            "four\nfive\nsix\n"
        )
        self.assertEqual(out[1]["source"], "claude")         # pre-2026-04-07 cutoff
        self.assertIsNone(out[0]["source"])                  # after cutoff stays untagged

    def test_trailing_short_entry_dropped(self):
        out = parse(
            "2026-06-01 06:00:01 UTC [claude]\n"
            "one\ntwo\nthree\n"
            "\n"
            "2026-06-01 12:00:01 UTC [claude]\n"
            "only one line\n"
        )
        self.assertEqual(len(out), 1)


class SlugTest(unittest.TestCase):
    def test_slug_format(self):
        h = {"timestamp": "2026-06-28 08:31:51 UTC", "source": "codex"}
        self.assertEqual(bs.slug(h), "20260628-083151-codex")

    def test_untagged_defaults_to_claude(self):
        h = {"timestamp": "2026-03-01 06:00:01 UTC", "source": None}
        self.assertEqual(bs.slug(h), "20260301-060001-claude")


class ComputeInsightTest(unittest.TestCase):
    @staticmethod
    def _haikus(source, n, unique):
        # `unique` distinct haikus, the rest repeats of the first one.
        out = []
        for k in range(n):
            idx = k if k < unique else 0
            out.append({"source": source, "lines": [f"line {idx}", "b", "c"]})
        return out

    def test_needs_two_ranked_engines(self):
        hs = self._haikus("claude", 30, 30) + self._haikus("codex", 10, 10)
        self.assertIsNone(bs.compute_insight(hs))            # codex below threshold

    def test_ranks_most_vs_least_unique(self):
        hs = self._haikus("claude", 30, 30) + self._haikus("codex", 30, 15)
        text = bs.compute_insight(hs)
        self.assertIn("claude almost never repeats itself", text)
        self.assertIn("100%", text)
        self.assertIn("codex", text)
        self.assertIn("50%", text)


class ModelChangesTest(unittest.TestCase):
    @staticmethod
    def _parse(text):
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
            f.write(text)
            path = f.name
        try:
            return bs.parse_model_changes(path)
        finally:
            os.unlink(path)

    def test_baseline_is_not_a_change(self):
        out = self._parse(
            "# comment line\n"
            "2026-06-28 08:31:51 UTC engine=claude model=claude-haiku-4-5-20251001\n"
            "2026-06-28 08:31:59 UTC engine=codex model=gpt-5.4\n"
        )
        self.assertEqual(out, [])

    def test_change_detected_per_engine(self):
        out = self._parse(
            "2026-06-28 08:31:51 UTC engine=claude model=old-model\n"
            "2026-06-28 08:31:59 UTC engine=codex model=gpt-5.4\n"
            "2026-06-29 08:31:51 UTC engine=claude model=new-model\n"
            "2026-06-29 08:31:59 UTC engine=codex model=gpt-5.4\n"
        )
        self.assertEqual(out, [{
            "engine": "claude", "ts": "2026-06-29 08:31:51 UTC",
            "from": "old-model", "to": "new-model",
        }])

    def test_missing_file_is_empty(self):
        self.assertEqual(bs.parse_model_changes("/nonexistent/model.log"), [])


class FeedTest(unittest.TestCase):
    HAIKUS = [
        {"date": "2026-06-02", "timestamp": "2026-06-02 06:00:09 UTC",
         "source": "codex", "lines": ["four & <five>", "five", "six"]},
        {"date": "2026-06-01", "timestamp": "2026-06-01 06:00:01 UTC",
         "source": "claude", "lines": ["one", "two", "three"]},
    ]

    def test_feed_is_valid_atom(self):
        import xml.etree.ElementTree as ET
        root = ET.fromstring(bs.build_feed(self.HAIKUS))
        ns = {"a": "http://www.w3.org/2005/Atom"}
        entries = root.findall("a:entry", ns)
        self.assertEqual(len(entries), 2)
        self.assertEqual(root.find("a:updated", ns).text, "2026-06-02T06:00:09Z")
        first = entries[0]
        self.assertTrue(first.find("a:id", ns).text.endswith("/h/20260602-060009-codex/"))
        self.assertEqual(first.find("a:title", ns).text, "four & <five>")
        # type="html" content: XML parse yields the escaped-HTML layer.
        self.assertEqual(first.find("a:content", ns).text,
                         "four &amp; &lt;five&gt;<br>five<br>six")

    def test_empty_archive_still_valid(self):
        import xml.etree.ElementTree as ET
        root = ET.fromstring(bs.build_feed([]))
        self.assertEqual(len(root.findall("{http://www.w3.org/2005/Atom}entry")), 0)


class MainEmptyArchiveTest(unittest.TestCase):
    """main() must not crash on an archive that parses to zero haikus."""

    INDEX = ('<meta property="og:description" content="untouched">\n'
             '<meta name="twitter:description" content="untouched">\n'
             '<meta property="og:image" content="untouched">\n'
             '<meta name="twitter:image" content="untouched">\n'
             '<meta property="og:image:alt" content="untouched">\n')

    def setUp(self):
        # main() writes through module-level paths, so redirect every one of
        # them into a temp dir: haiku.txt is production data, never truncate it.
        self.tmp = tempfile.mkdtemp()
        self._orig = {k: getattr(bs, k) for k in (
            "HAIKU_FILE", "MODEL_LOG_FILE", "SITE_DIR", "OUTPUT_FILE",
            "MODELS_FILE", "FEED_FILE", "INDEX_FILE", "SHARE_DIR")}
        bs.HAIKU_FILE = os.path.join(self.tmp, "haiku.txt")
        bs.MODEL_LOG_FILE = os.path.join(self.tmp, "model.log")
        bs.SITE_DIR = os.path.join(self.tmp, "site")
        bs.OUTPUT_FILE = os.path.join(bs.SITE_DIR, "haiku.json")
        bs.MODELS_FILE = os.path.join(bs.SITE_DIR, "models.json")
        bs.FEED_FILE = os.path.join(bs.SITE_DIR, "feed.xml")
        bs.INDEX_FILE = os.path.join(bs.SITE_DIR, "index.html")
        bs.SHARE_DIR = os.path.join(bs.SITE_DIR, "h")
        os.makedirs(bs.SITE_DIR)
        with open(bs.INDEX_FILE, "w") as f:
            f.write(self.INDEX)

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(bs, k, v)
        shutil.rmtree(self.tmp)

    def _run_main(self, haiku_text):
        with open(bs.HAIKU_FILE, "w") as f:
            f.write(haiku_text)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            bs.main()
        return out.getvalue()

    def test_empty_archive_exits_cleanly(self):
        out = self._run_main("")                             # no IndexError
        self.assertIn("No haikus parsed", out)
        with open(bs.OUTPUT_FILE) as f:
            self.assertEqual(json.load(f), [])
        self.assertTrue(os.path.isfile(bs.FEED_FILE))        # feed still written
        with open(bs.INDEX_FILE) as f:
            self.assertEqual(f.read(), self.INDEX)           # OG left untouched

    def test_unparseable_non_empty_archive_fails_loudly(self):
        # Content that yields no haikus means a broken parse, not a fresh fork.
        with self.assertRaises(SystemExit) as cm:
            self._run_main("not a timestamp header\nnor this\n")
        self.assertIn("parsed to 0 haikus", str(cm.exception))

    def test_full_archive_injects_og(self):
        out = self._run_main(
            "2026-06-01 06:00:01 UTC [claude]\n"
            "one\ntwo\nthree\n"
        )
        self.assertIn("Injected OG", out)
        with open(bs.INDEX_FILE) as f:
            self.assertIn("20260601-060001-claude/og.png", f.read())


class ModelChangePlaceholderTest(unittest.TestCase):
    """Placeholder model ids ("default", "unknown") are not readings, so they
    must never produce a model-change marker — otherwise merely renaming the
    placeholder fabricates a swap on the sentiment chart."""

    def _changes(self, body):
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
            f.write(body)
            path = f.name
        try:
            return bs.parse_model_changes(path)
        finally:
            os.unlink(path)

    def test_placeholder_rename_is_not_a_change(self):
        # The exact regression: agy's historic "default" lines followed by the
        # new "unknown" spelling must stay silent.
        self.assertEqual(self._changes(
            "2026-06-01 06:00:00 UTC engine=agy model=default\n"
            "2026-06-02 06:00:00 UTC engine=agy model=unknown\n"
        ), [])

    def test_placeholder_is_not_a_baseline(self):
        # A placeholder between two runs of the same real id is a gap in the
        # record, not a swap out and back.
        self.assertEqual(self._changes(
            "2026-06-01 06:00:00 UTC engine=codex model=gpt-5.4\n"
            "2026-06-02 06:00:00 UTC engine=codex model=unknown\n"
            "2026-06-03 06:00:00 UTC engine=codex model=gpt-5.4\n"
        ), [])

    def test_real_model_swap_still_reported(self):
        # Guard against over-suppressing: a genuine roll must still fire, even
        # across an intervening placeholder.
        changes = self._changes(
            "2026-06-01 06:00:00 UTC engine=codex model=gpt-5.4\n"
            "2026-06-02 06:00:00 UTC engine=codex model=unknown\n"
            "2026-06-03 06:00:00 UTC engine=codex model=gpt-5.5\n"
        )
        self.assertEqual(len(changes), 1)
        self.assertEqual((changes[0]["from"], changes[0]["to"]), ("gpt-5.4", "gpt-5.5"))


if __name__ == "__main__":
    unittest.main()
