// Unit tests for site/experimental.js (the free-model bench page).
const test = require("node:test");
const assert = require("node:assert/strict");
const { esc, benchName, fmtUtc, renderBench } = require("../site/experimental.js");

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
  assert.match(html, /title="reasoning effort">high</);
  assert.match(html, /2\/2/);
  assert.match(html, /1 more listed model never answered/);
  assert.equal(esc(`"'`), "&quot;&#39;");
});

test("renderBench has an empty state", () => {
  assert.match(renderBench({ window_days: 14, runs_in_window: 0, latest_run: null, haikus: [], models: [] }),
    /No bench runs published yet/);
});
