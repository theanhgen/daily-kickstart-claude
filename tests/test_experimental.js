// Unit tests for site/experimental.js (the free-model bench page).
const test = require("node:test");
const assert = require("node:assert/strict");
const { esc, benchName, fmtUtc, renderBench, familyClass, cloudSize, wordDetail, renderCloud,
  cloudLegend, familyDetail } = require("../site/experimental.js");

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
  assert.match(html, /<td class="num">2×<\/td>\s*<td class="num">2<\/td>/);   // used, answered
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
  assert.equal(familyClass("qwen"), "other");
  assert.equal(familyClass(null), "shared");
});

test("cloud sizes span the range by square root", () => {
  assert.equal(cloudSize(3, 3, 147), 0.85);
  assert.equal(cloudSize(147, 3, 147), 2.6);
  assert.ok(Math.abs(cloudSize(39, 3, 147) - (0.85 + 1.75 * 0.5)) < 1e-9);
  assert.equal(cloudSize(5, 5, 5), (0.85 + 2.6) / 2);
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
  assert.match(html, /data-family="gemini"/);
  assert.match(html, /<button type="button" class="cloud-key fam-shared" data-family="shared"/);
});

test("the legend lists every family that leans on a word, named three first", () => {
  const words = [
    { word: "a", owner: "qwen" }, { word: "b", owner: "nemotron" }, { word: "c", owner: "nemotron" },
    { word: "d", owner: "llama" }, { word: "e", owner: null }, { word: "f", owner: "gemini" },
    { word: "g", owner: "other" },
  ];
  // gemini and llama in their fixed order (mistral has none), then by count, then name.
  assert.deepEqual(cloudLegend(words),
    [["gemini", 1], ["llama", 1], ["nemotron", 2], ["other", 1], ["qwen", 1], ["shared", 1]]);
  const html = renderCloud({ haikus: 3, words: words.map(w => ({ ...w, uses: 3, families: [], models: 1 })) });
  assert.match(html, /class="cloud-key fam-other" data-family="nemotron"[^>]*><i><\/i>nemotron <span class="cloud-key-n">2</);
  assert.match(html, />unclassified </);
  assert.equal(familyDetail(words, "nemotron"), "nemotron leans on 2 words: b, c");
  assert.equal(familyDetail(words, "shared"), "shared by all: 1 word no one family leans on");
});
