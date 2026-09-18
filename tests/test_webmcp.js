// Unit tests for site/webmcp.js (the WebMCP tools) and site/llms.txt.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { tools, latestHaikus, searchHaikus, benchSection, slugOf } = require("../site/webmcp.js");
const main = require("../site/main.js");

const BASE = "https://theanhgen.github.io/daily-kickstart-claude/";
const haikus = [   // haiku.json order: newest first
  { date: "2026-09-13", timestamp: "2026-09-13 20:00:13 UTC", source: "codex", lines: ["Morning spills soft gold", "b", "c"] },
  { date: "2026-09-13", timestamp: "2026-09-13 20:00:03 UTC", source: "claude", lines: ["Morning Pi hums low", "b", "c"] },
  { date: "2026-09-01", timestamp: "2026-09-01 04:00:00 UTC", source: "agy", lines: ["Autumn LEAVES fall", "b", "c"] },
];

test("tools have MCP-shaped names, descriptions and object schemas", () => {
  const list = tools(BASE);
  assert.deepEqual(list.map(t => t.name), ["get_latest_haikus", "search_haikus", "get_free_model_bench"]);
  for (const t of list) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/);
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.annotations.readOnlyHint, true);
    for (const [key, prop] of Object.entries(t.inputSchema.properties)) assert.ok(prop.description, `${t.name}.${key}`);
    for (const key of t.inputSchema.required || []) assert.ok(t.inputSchema.properties[key], `${t.name} requires ${key}`);
  }
});

// The pages load webmcp.js as a classic script beside main.js or experimental.js, and
// classic scripts share one global scope: a top-level name declared twice is a
// SyntaxError that kills the later file. Run each pair in one context, as the browser does.
test("webmcp.js loads beside each page's script without a global clash", () => {
  const site = f => fs.readFileSync(path.join(__dirname, "..", "site", f), "utf8");
  for (const page of ["main.js", "experimental.js"]) {
    const ctx = vm.createContext({ URL, console });
    vm.runInContext(site(page), ctx, { filename: page });
    assert.doesNotThrow(() => vm.runInContext(site("webmcp.js"), ctx, { filename: "webmcp.js" }), page);
  }
});

test("slugOf matches main.js, so tool permalinks resolve", () => {
  for (const h of haikus) assert.equal(slugOf(h), main.slugOf(h));
});

test("latest haikus: newest first, engine filter, limit clamped", () => {
  assert.deepEqual(latestHaikus(haikus, {}, BASE).map(h => h.engine), ["codex", "claude", "agy"]);
  assert.deepEqual(latestHaikus(haikus, { engine: "agy" }, BASE).map(h => h.lines[0]), ["Autumn LEAVES fall"]);
  assert.equal(latestHaikus(haikus, { limit: 1 }, BASE).length, 1);
  assert.equal(latestHaikus(haikus, { limit: 0 }, BASE).length, 1);
  assert.equal(latestHaikus(haikus, {}, BASE)[0].url, `${BASE}h/20260913-200013-codex/`);
});

test("search: case-insensitive text, engine and inclusive date range", () => {
  assert.equal(searchHaikus(haikus, { query: "leaves" }, BASE).total, 1);
  assert.equal(searchHaikus(haikus, { query: "morning" }, BASE).total, 2);
  assert.equal(searchHaikus(haikus, { query: "morning", engine: "claude" }, BASE).total, 1);
  assert.equal(searchHaikus(haikus, { from: "2026-09-13" }, BASE).total, 2);
  assert.equal(searchHaikus(haikus, { to: "2026-09-01" }, BASE).total, 1);
  const all = searchHaikus(haikus, { limit: 2 }, BASE);
  assert.deepEqual([all.total, all.haikus.length], [3, 2]);
});

test("bench sections", () => {
  const bench = {
    window_days: 14, runs_in_window: 9, latest_run: { ok: 1 },
    cloud: { haikus: 5, words: [{ word: "leaves", uses: 9, weight: 3, owner: null, families: [], models: 4 }] },
    haikus: [{ model: "a/m", provider: "a", effort: "high", lines: ["x", "y", "z"] }],
    models: [{ model: "a/m", provider: "a", effort: null, lineage: "qwen", asked: 9, ok: 7, last_ok: "t" }],
  };
  assert.deepEqual(benchSection(bench, "cloud").words, [{ word: "leaves", uses: 9, family: null, models: 4 }]);
  assert.equal(benchSection(bench, "latest_run").haikus[0].effort, "high");
  assert.deepEqual(benchSection(bench, "models").models[0],
    { model: "a/m", provider: "a", effort: "default", family: "qwen", used: 9, answered: 7, last_answer: "t" });
  assert.throws(() => benchSection(bench, "nope"), /section must be one of/);
});

test("llms.txt passes Lighthouse's checks: an H1, a link, not too short", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "site", "llms.txt"), "utf8");
  // The same three tests as lighthouse core/audits/agentic/llms-txt.js.
  assert.match(text, /^\s*#\s+.+/m);
  assert.match(text, /\[.+\]\(.+\)/);
  assert.ok(text.length >= 50);
});
