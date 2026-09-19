// Unit tests for site/webmcp.js (the WebMCP tools) and site/llms.txt.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { tools, respond, latestHaikus, searchHaikus, haikusForWord, searchByWord, wordCloud, wordTrends,
  compareEngines, benchSection, slugOf, tokens, moodRaw, moodAgg, is575 } = require("../site/webmcp.js");
const main = require("../site/main.js");

const BASE = "https://theanhgen.github.io/daily-kickstart-claude/";
const haikus = [   // haiku.json order: newest first
  { date: "2026-09-13", timestamp: "2026-09-13 20:00:13 UTC", source: "codex", lines: ["Morning spills soft gold", "b", "c"] },
  { date: "2026-09-13", timestamp: "2026-09-13 20:00:03 UTC", source: "claude", lines: ["Morning Pi hums low", "b", "c"] },
  { date: "2026-09-01", timestamp: "2026-09-01 04:00:00 UTC", source: "agy", lines: ["Autumn LEAVES fall", "b", "c"] },
];

test("tools have MCP-shaped names, descriptions and object schemas", () => {
  const list = tools(BASE);
  assert.deepEqual(list.map(t => t.name), ["get_latest_haikus", "search_haikus", "get_haikus_for_word",
    "search_by_word", "get_word_cloud", "get_word_trends", "compare_engines", "get_free_model_bench"]);
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

// The word and mood helpers are copies of main.js's: the tools must give the Archive page's numbers.
test("word and mood helpers agree with main.js on the whole archive", () => {
  const archive = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "site", "haiku.json"), "utf8"));
  for (const h of archive) {
    assert.deepEqual(tokens(h), main.tokens(h), h.timestamp);
    assert.deepEqual(moodRaw(h), main.moodRaw(h), h.timestamp);
    assert.equal(is575(h), main.is575(h), h.timestamp);
  }
  for (const e of ["claude", "codex", "agy"]) {
    const es = archive.filter(h => h.source === e);
    assert.deepEqual(moodAgg(es), main.moodAgg(es), e);
  }
});

const words = [   // newest first, as haiku.json
  { date: "2026-09-10", timestamp: "2026-09-10 09:00:00 UTC", source: "agy", lines: ["Winter's frost holds", "sea and season", "frost frost"] },
  { date: "2026-08-03", timestamp: "2026-08-03 09:00:00 UTC", source: "codex", lines: ["warm light blooms", "the sea", "light"] },
  { date: "2026-08-01", timestamp: "2026-08-01 09:00:00 UTC", source: "claude", lines: ["winter sea", "blossom blossoms", "silent"] },
];

test("haikus for a word: whole word and possessive, never a fragment; order and counts", () => {
  const winter = haikusForWord(words, { word: "Winter" }, BASE);
  assert.deepEqual([winter.total, winter.by_engine], [2, { claude: 1, codex: 0, agy: 1 }]);
  assert.deepEqual(winter.haikus.map(h => h.engine), ["agy", "claude"]);
  assert.deepEqual(haikusForWord(words, { word: "winter", order: "oldest" }, BASE).haikus.map(h => h.engine), ["claude", "agy"]);
  assert.equal(haikusForWord(words, { word: "sea" }, BASE).total, 3);   // "season" isn't "sea"
  assert.equal(haikusForWord(words, { word: "seas" }, BASE).total, 0);
  assert.equal(haikusForWord(words, { word: "sea", engine: "codex" }, BASE).total, 1);
  assert.throws(() => haikusForWord(words, { word: "two words" }, BASE), /single word/);
  assert.throws(() => haikusForWord(words, { word: "sea", order: "random" }, BASE), /order must be/);
});

test("search by word: prefix, contains and exact over the vocabulary", () => {
  const blos = searchByWord(words, { query: "blos" });
  assert.deepEqual(blos.words.map(w => w.word), ["blossom", "blossoms"]);
  const frost = searchByWord(words, { query: "frost", match: "exact" }).words[0];
  assert.deepEqual(frost, { word: "frost", uses: 3, haikus: 1, by_engine: { claude: 0, codex: 0, agy: 3 },
    first_used: "2026-09-10", last_used: "2026-09-10" });
  assert.deepEqual(searchByWord(words, { query: "eas", match: "contains" }).words.map(w => w.word), ["season"]);
  const sea = searchByWord(words, { query: "sea" }).words.find(w => w.word === "sea");
  assert.deepEqual([sea.first_used, sea.last_used], ["2026-08-01", "2026-09-10"]);
  assert.throws(() => searchByWord(words, { query: "" }), /query must be/);
  assert.throws(() => searchByWord(words, { query: "sea", match: "fuzzy" }), /match must be/);
});

test("word cloud: the Archive's counting (stopwords and short words out), per engine", () => {
  const cloud = wordCloud(words, {});
  assert.equal(cloud.haikus, 3);
  assert.deepEqual(cloud.words.slice(0, 2), [
    { word: "frost", uses: 3, by_engine: { claude: 0, codex: 0, agy: 3 } },
    { word: "sea", uses: 3, by_engine: { claude: 1, codex: 1, agy: 1 } },
  ]);
  assert.ok(!cloud.words.some(w => ["the", "and"].includes(w.word) || w.word.length < 3));
  assert.deepEqual(wordCloud(words, { engine: "claude", limit: 1 }).words.map(w => w.word), ["blossom"]);
  assert.equal(wordCloud(words, { from: "2026-09-01" }).haikus, 1);
});

test("word trends: per period, with haiku counts and a rate", () => {
  const t = wordTrends(words, { words: ["sea", "Frost"] });
  assert.deepEqual(t.words, ["sea", "frost"]);
  assert.deepEqual(t.totals, { sea: 3, frost: 3 });
  assert.deepEqual(t.periods.map(p => [p.period, p.haikus, p.uses.sea, p.per_100_haikus.sea]),
    [["2026-08", 2, 2, 100], ["2026-09", 1, 1, 100]]);
  assert.deepEqual(wordTrends(words, { words: "sea", period: "week" }).periods.map(p => p.period),
    ["2026-07-27", "2026-08-03", "2026-09-07"]);   // each week's Monday
  assert.throws(() => wordTrends(words, { words: ["a", "b", "c", "d", "e", "f"] }), /1 to 5/);
  assert.throws(() => wordTrends(words, { words: ["sea"], period: "year" }), /period must be/);
});

test("compare engines: per-engine stats, skipping engines with no haikus in range", () => {
  const c = compareEngines(words, { from: "2026-08-02" });
  assert.deepEqual(c.engines.map(e => e.engine), ["codex", "agy"]);
  const agy = c.engines[1];
  assert.deepEqual([agy.haikus, agy.first, agy.unique_haikus_pct], [1, "2026-09-10", 100]);
  assert.deepEqual(agy.top_words[0], { word: "frost", uses: 3 });
  assert.deepEqual([agy.mood.n, agy.mood.label], [1, "cool"]);   // frost is a cool word
  assert.deepEqual(compareEngines(words, {}).engines.map(e => e.engine), ["claude", "codex", "agy"]);
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

test("a tool that fails tells the agent why, as an MCP error result", async () => {
  assert.deepEqual(await respond(() => ({ ok: 1 })), { content: [{ type: "text", text: '{"ok":1}' }] });
  assert.deepEqual(await respond(() => wordTrends(words, { words: [] })),
    { content: [{ type: "text", text: "words must be 1 to 5 single words" }], isError: true });
});

test("llms.txt passes Lighthouse's checks: an H1, a link, not too short", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "site", "llms.txt"), "utf8");
  // The same three tests as lighthouse core/audits/agentic/llms-txt.js.
  assert.match(text, /^\s*#\s+.+/m);
  assert.match(text, /\[.+\]\(.+\)/);
  assert.ok(text.length >= 50);
});
