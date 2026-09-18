// Unit tests for site/experimental.js (the free-model bench page).
const test = require("node:test");
const assert = require("node:assert/strict");
const { esc, benchName, fmtUtc, renderBench, familyClass, cloudSize, wordDetail, renderCloud, packCloud } = require("../site/experimental.js");

test("benchName drops the provider prefix and the effort suffix", () => {
  assert.equal(benchName("agy/gemini-3.7-flash-high", "agy"), "gemini-3.7-flash");
  assert.equal(benchName("cline/z-ai/glm-5.2:free", "cline"), "z-ai/glm-5.2:free");
  assert.equal(benchName("x/model-xhigh:free", "x"), "model:free");
  assert.equal(benchName("oc/big-pickle", "oc"), "big-pickle");
});

test("fmtUtc keeps UTC", () => {
  assert.equal(fmtUtc("2026-09-18 06:01:00 UTC"), "Sep 18, 06:01 UTC");
});

const data = {
  window_days: 14, runs_in_window: 2,
  latest_run: { started: "2026-09-18 06:00:00 UTC", listed: 4, skipped: 1, ok: 1, failed: 2 },
  haikus: [{ model: "agy/m-high", provider: "agy", effort: "high", timestamp: "2026-09-18 06:01:00 UTC",
             lines: ["<b>one</b>", "two", "three"] }],
  models: [
    { model: "agy/m-high", provider: "agy", effort: "high", asked: 2, ok: 2, last_ok: "2026-09-18 06:01:00 UTC" },
    { model: "b/dead", provider: "b", effort: "default", asked: 3, ok: 0, last_ok: null },
  ],
};

test("renderBench escapes haiku text and shows effort, counts and silent models", () => {
  const html = renderBench(data);
  assert.ok(html.includes("&lt;b&gt;one&lt;/b&gt;"));
  assert.ok(!html.includes("<b>one</b>"));
  assert.match(html, /1 of 3 answered · Sep 18, 06:00 UTC · 1 skipped/);
  // The latest run is folded away; the word cloud leads the page.
  assert.equal((html.match(/<details class="month-group bench-fold">/g) || []).length, 2);   // latest run + models
  assert.match(html, /Models<\/span>\s*<span class="month-count">1 answered · last 14 days · 2 runs/);
  assert.match(html, /title="reasoning effort">high</);
  assert.match(html, /2\/2/);
  assert.match(html, /1 more listed model never answered/);
  assert.equal(esc(`"'`), "&quot;&#39;");
});

test("renderBench has an empty state", () => {
  assert.match(renderBench({ window_days: 14, runs_in_window: 0, latest_run: null, haikus: [], models: [] }),
    /No bench runs published yet/);
});

test("cloud colours go to named families only, never by rank", () => {
  assert.equal(familyClass("gemini"), "gemini");
  assert.equal(familyClass("llama"), "llama");
  assert.equal(familyClass("mistral"), "mistral");
  assert.equal(familyClass("qwen"), "other");
  assert.equal(familyClass(null), "shared");
});

test("cloud sizes span the range by square root", () => {
  assert.equal(cloudSize(3, 3, 147), 0.85);
  assert.equal(cloudSize(147, 3, 147), 3.2);
  assert.ok(Math.abs(cloudSize(39, 3, 147) - (0.85 + 2.35 * 0.5)) < 1e-9);
  assert.equal(cloudSize(5, 5, 5), (0.85 + 3.2) / 2);
});

test("renderCloud escapes words and carries the breakdown", () => {
  const cloud = { haikus: 12, words: [
    { word: "<moon>", uses: 9, owner: "gemini", families: [["gemini", 7], ["qwen", 2]], models: 3 },
    { word: "leaves", uses: 4, owner: null, families: [["mistral", 2]], models: 1 },
  ] };
  const html = renderCloud(cloud);
  assert.ok(html.includes("&lt;moon&gt;") && !html.includes("<moon>"));
  assert.match(html, /class="cloud-word fam-gemini"/);
  assert.match(html, /class="cloud-word fam-shared"/);
  assert.match(html, /2 most-used words · 12 haikus/);
  assert.equal(wordDetail(cloud.words[1]), "leaves: 4 uses by 1 model (mistral 2)");
  assert.equal(renderCloud({ haikus: 0, words: [] }), "");
  // Most-used first: the packing order.
  assert.ok(html.indexOf("&lt;moon&gt;") < html.indexOf(">leaves<"));
});

// Deterministic pseudo-random boxes shaped like words: 20-240px wide, 16-45px tall.
function boxes(n, seed = 7) {
  let x = seed;
  const rnd = () => (x = Math.imul(x, 48271) % 2147483647) / 2147483647;
  return Array.from({ length: n }, () => {
    const h = 16 + 29 * rnd();
    return { w: Math.max(20, h * (1 + 5 * rnd())), h };
  }).sort((a, b) => b.h - a.h);
}

test("packCloud puts the biggest word dead centre and never overlaps two words", () => {
  for (const width of [340, 700]) {
    const input = boxes(80);
    const out = packCloud(input, width);
    assert.equal(out.length, 80);
    assert.deepEqual(out[0], { x0: -input[0].w / 2, x1: input[0].w / 2, y0: -input[0].h / 2, y1: input[0].h / 2 });
    out.forEach((r, i) => {
      assert.ok(Math.abs(r.x1 - r.x0 - input[i].w) < 1e-9 && Math.abs(r.y1 - r.y0 - input[i].h) < 1e-9);
      assert.ok(r.x0 >= -width / 2 - 1e-9 && r.x1 <= width / 2 + 1e-9, `box ${i} leaves the column`);
      for (const q of out.slice(0, i)) {
        const apart = r.x1 <= q.x0 || q.x1 <= r.x0 || r.y1 <= q.y0 || q.y1 <= r.y0;
        assert.ok(apart, `box ${i} overlaps`);
      }
    });
  }
});

test("packCloud grows a narrow column downward, and is the same on every load", () => {
  const height = rects => Math.max(...rects.map(r => r.y1)) - Math.min(...rects.map(r => r.y0));
  const narrow = packCloud(boxes(80), 340), wide = packCloud(boxes(80), 700);
  assert.ok(height(narrow) > height(wide));
  assert.deepEqual(packCloud(boxes(80), 340), narrow);
});

test("packCloud gives a word wider than the column a row of its own", () => {
  const out = packCloud([{ w: 100, h: 20 }, { w: 500, h: 30 }], 300);
  assert.deepEqual(out[1], { x0: -250, x1: 250, y0: 13, y1: 43 });
});
