// Unit tests for site/main.js pure helpers (node --test tests/test_main.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { esc, slugOf, syllables, lineSyllables, is575, shortModel } = require("../site/main.js");

test("esc neutralizes HTML in haiku content", () => {
  assert.equal(esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(esc(`a & b's "quote"`), "a &amp; b&#39;s &quot;quote&quot;");
});

// Same fixtures as SlugTest in tests/test_build_site.py — the two slug
// implementations must agree or permalinks 404.
test("slugOf matches build-site.py slug()", () => {
  assert.equal(slugOf({ timestamp: "2026-06-28 08:31:51 UTC", source: "codex" }), "20260628-083151-codex");
  assert.equal(slugOf({ timestamp: "2026-03-01 06:00:01 UTC", source: null }), "20260301-060001-claude");
});

// Pins the heuristic's behavior on words where it matches real English.
test("syllable estimates", () => {
  const expected = {
    moon: 1, light: 1, sky: 1, frog: 1,
    silence: 2, ripples: 2, morning: 2, golden: 2, whisper: 2,
    table: 2, carry: 2,
  };
  for (const [word, n] of Object.entries(expected)) {
    assert.equal(syllables(word), n, `syllables(${word})`);
  }
});

test("the README's example haiku scores 5-7-5", () => {
  const h = {
    lines: ["Still pond reflects sky", "A frog leaps into silence", "Ripples carry light"],
  };
  assert.deepEqual(h.lines.map(lineSyllables), [5, 7, 5]);
  assert.equal(is575(h), true);
});

test("is575 rejects off-meter and short entries", () => {
  assert.equal(is575({ lines: ["one two", "three four", "five six"] }), false);
  assert.equal(is575({ lines: ["Still pond reflects sky", "A frog leaps into silence"] }), false);
});

test("shortModel strips engine prefix and date suffix", () => {
  assert.equal(shortModel("claude", "claude-haiku-4-5-20251001"), "haiku-4-5");
  assert.equal(shortModel("codex", "gpt-5.4"), "gpt-5.4");
  assert.equal(shortModel("agy", "default"), "default");
});
