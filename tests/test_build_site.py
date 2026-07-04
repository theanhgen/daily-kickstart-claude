#!/usr/bin/env python3
"""Unit tests for scripts/build-site.py (parser, slug, insight)."""
import importlib.util
import os
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


if __name__ == "__main__":
    unittest.main()
