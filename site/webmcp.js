// WebMCP tools (https://developer.chrome.com/docs/ai/webmcp): lets an AI agent in the
// browser read the haikus through typed, read-only tools instead of scraping the page.
// The site has no forms, so there is nothing to annotate declaratively; these are the
// imperative API. Data is fetched when a tool runs, never on page load.
//
// Registered only where the browser exposes the API: Chrome with the WebMCP origin
// trial token for this origin, or chrome://flags/#enable-webmcp-testing. Everywhere
// else this file does nothing.

// Everything sits in one function scope: the pages load this beside main.js or
// experimental.js as classic scripts, which share one global scope, and main.js already
// declares ENGINES and slugOf (a second const ENGINES was a SyntaxError that killed
// this whole file).
(() => {
  const ENGINES = ["claude", "codex", "agy"];
  const BENCH_SECTIONS = ["cloud", "latest_run", "models"];
  const PERIODS = ["month", "week"];
  const ORDERS = ["newest", "oldest"];

  async function getJson(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  function slugOf(h) {   // mirrors slugOf() in main.js and slug() in scripts/build-site.py
    const stamp = h.timestamp.slice(0, 19).replace(/-/g, "").replace(/:/g, "").replace(" ", "-");
    return `${stamp}-${h.source || "claude"}`;
  }

  function clampLimit(n, dflt, max) {
    const v = Number.isInteger(n) ? n : dflt;
    return Math.max(1, Math.min(max, v));
  }

  function shapeHaiku(h, base) {
    return { engine: engineOf(h), timestamp: h.timestamp, lines: h.lines,
      url: new URL(`h/${slugOf(h)}/`, base).href };
  }

  const engineOf = h => h.source || "claude";
  const round1 = x => Math.round(x * 10) / 10;
  const perEngine = () => Object.fromEntries(ENGINES.map(e => [e, 0]));
  const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

  function filterHaikus(haikus, { engine, from, to } = {}) {
    return haikus.filter(h => (!engine || engineOf(h) === engine)
      && (!from || h.date >= from) && (!to || h.date <= to));
  }

  // One word as the tools accept it: lowercase letters and apostrophes, else null.
  function normWord(s) {
    const w = String(s ?? "").trim().toLowerCase();
    return /^[a-z']+$/.test(w) ? w : null;
  }

  // ── Word and mood analysis, mirrored from main.js so the tools report the same numbers
  // as the Archive page (tests/test_webmcp.js checks both agree on the whole archive).
  // Mirrored rather than shared: the Experimental page loads this file without main.js.

  const STOP = new Set(("the a an and or but of to in on at by for with from into as is are was " +
    "be it its his her their our your my this that these those then than so no not all each").split(" "));

  // Every word, for lookups; tokens() drops stopwords and short words, as main.js does.
  const wordsOf = h => h.lines.flatMap(line => line.toLowerCase().match(/[a-z']+/g) || []);
  const tokens = h => wordsOf(h).filter(w => w.length > 2 && !STOP.has(w));
  // A whole-word match that also takes the possessive: "winter" finds "winter's", not "wintering".
  const sameWord = (w, q) => w === q || w === `${q}'s`;

  function countWords(haikus) {
    const c = new Map();
    for (const h of haikus) for (const w of tokens(h)) c.set(w, (c.get(w) || 0) + 1);
    return c;
  }

  const byUses = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1);

  const MOOD_WARM = new Set(("light dawn spring bloom blooms sun warms warm gold golden bright " +
    "green coffee wake wakes awakens waking soft softly steam breathes hums opens flows flow " +
    "fresh glow blossom cherry hope joy clear gentle alive sunlight daylight").split(" "));
  const MOOD_COOL = new Set(("silent silence frost snow cold winter empty bare void dark shadow " +
    "fade fades falls fall descend descends drift drifts mist night lost alone gray grey still " +
    "sleeps sleep fading hollow ash dusk frozen freeze chill barren").split(" "));
  const MOOD_NEG = new Set("not no never without nor none cannot".split(" "));
  const MOOD_K = 2;

  function moodRaw(h) {
    let net = 0, scored = 0;
    for (const l of h.lines) {
      let negLeft = 0;
      for (const w of l.toLowerCase().match(/[a-z']+/g) || []) {
        if (MOOD_NEG.has(w)) { negLeft = 3; continue; }
        const s = MOOD_WARM.has(w) ? 1 : MOOD_COOL.has(w) ? -1 : 0;
        if (s) { net += negLeft > 0 ? -s : s; scored++; }
        if (negLeft > 0) negLeft--;
      }
    }
    return { score: scored ? net / (scored + MOOD_K) : 0, scored, net };
  }

  function moodAgg(arr) {
    if (!arr.length) return null;
    const xs = arr.map(h => moodRaw(h).score);
    const n = xs.length;
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
    const ci = n > 1 ? 1.96 * sd / Math.sqrt(n) : 0;
    const r2 = v => Math.round(v * 100) / 100;
    const label = mean - ci > 0.03 ? "warm" : mean + ci < -0.03 ? "cool" : "even";
    return { n, score: r2(mean), ci: r2(ci), lo: r2(mean - ci), hi: r2(mean + ci), label };
  }

  function syllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!w) return 0;
    let n = (w.match(/[aeiouy]+/g) || []).length;
    if (w.length > 2 && w.endsWith("e") && !"aeiouy".includes(w[w.length - 2]) && !/[^aeiouy]le$/.test(w)) n--;
    return Math.max(1, n);
  }

  const lineSyllables = line => (line.match(/[a-zA-Z']+/g) || []).reduce((s, w) => s + syllables(w), 0);
  const is575 = h => h.lines.length === 3 && h.lines.every((l, i) => lineSyllables(l) === [5, 7, 5][i]);
  const normHaiku = h => h.lines.map(l => l.toLowerCase().trim()).join(" / ");

  // haiku.json is newest first.
  function latestHaikus(haikus, { limit, engine } = {}, base = "https://example.invalid/") {
    return filterHaikus(haikus, { engine })
      .slice(0, clampLimit(limit, 3, 20)).map(h => shapeHaiku(h, base));
  }

  function searchHaikus(haikus, { query, engine, from, to, limit } = {}, base = "https://example.invalid/") {
    const q = (query || "").trim().toLowerCase();
    const hits = filterHaikus(haikus, { engine, from, to })
      .filter(h => !q || h.lines.join(" ").toLowerCase().includes(q));
    return { total: hits.length, haikus: hits.slice(0, clampLimit(limit, 10, 50)).map(h => shapeHaiku(h, base)) };
  }

  // The Archive's vocabulary: stopwords and words under three letters dropped, as on the page.
  function wordCloud(haikus, { engine, from, to, limit } = {}) {
    const hs = filterHaikus(haikus, { engine, from, to });
    const found = new Map();
    for (const h of hs) {
      for (const w of tokens(h)) {
        const f = found.get(w) || { word: w, uses: 0, by_engine: perEngine() };
        f.uses++;
        bump(f.by_engine, engineOf(h));
        found.set(w, f);
      }
    }
    const words = [...found.values()].sort((a, b) => byUses([a.word, a.uses], [b.word, b.uses]));
    return { haikus: hs.length, unique_words: found.size, words: words.slice(0, clampLimit(limit, 30, 100)) };
  }

  const MATCHES = {
    prefix: (w, q) => w.startsWith(q),
    contains: (w, q) => w.includes(q),
    exact: sameWord,
  };

  // Look words up in the vocabulary: which words match, how often, by whom, and when.
  function searchByWord(haikus, { query, match = "prefix", engine, from, to, limit } = {}) {
    const q = normWord(query);
    if (!q) throw new Error("query must be a word: letters and apostrophes only");
    if (!MATCHES[match]) throw new Error(`match must be one of ${Object.keys(MATCHES).join(", ")}`);
    const found = new Map();
    for (const h of filterHaikus(haikus, { engine, from, to })) {
      const seen = new Set();
      for (const w of wordsOf(h)) {
        if (!MATCHES[match](w, q)) continue;
        const f = found.get(w) || { word: w, uses: 0, haikus: 0, by_engine: perEngine(), first_used: h.date, last_used: h.date };
        f.uses++;
        bump(f.by_engine, engineOf(h));
        if (!seen.has(w)) { seen.add(w); f.haikus++; }
        if (h.date < f.first_used) f.first_used = h.date;
        if (h.date > f.last_used) f.last_used = h.date;
        found.set(w, f);
      }
    }
    const words = [...found.values()].sort((a, b) => byUses([a.word, a.uses], [b.word, b.uses]));
    return { query: q, match, total_words: found.size, words: words.slice(0, clampLimit(limit, 20, 100)) };
  }

  function haikusForWord(haikus, { word, engine, from, to, order = "newest", limit } = {}, base = "https://example.invalid/") {
    const w = normWord(word);
    if (!w) throw new Error("word must be a single word: letters and apostrophes only");
    if (!ORDERS.includes(order)) throw new Error(`order must be one of ${ORDERS.join(", ")}`);
    const hits = filterHaikus(haikus, { engine, from, to }).filter(h => wordsOf(h).some(x => sameWord(x, w)));
    hits.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1) * (order === "oldest" ? 1 : -1));
    const counts = perEngine();
    for (const h of hits) bump(counts, engineOf(h));
    return { word: w, total: hits.length, by_engine: counts,
      haikus: hits.slice(0, clampLimit(limit, 10, 50)).map(h => shapeHaiku(h, base)) };
  }

  function periodOf(date, period) {
    if (period === "month") return date.slice(0, 7);
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);   // back to that week's Monday
    return d.toISOString().slice(0, 10);
  }

  // Uses per month or week, with the period's haiku count and a rate, since the number of
  // haikus per period changes (agy joined later; runs fail when an engine hits its limit).
  function wordTrends(haikus, { words, period = "month", engine, from, to } = {}) {
    const list = [...new Set((Array.isArray(words) ? words : [words]).map(normWord))];
    if (!list.length || list.length > 5 || list.includes(null)) throw new Error("words must be 1 to 5 single words");
    if (!PERIODS.includes(period)) throw new Error(`period must be one of ${PERIODS.join(", ")}`);
    const rows = new Map();
    for (const h of filterHaikus(haikus, { engine, from, to })) {
      const key = periodOf(h.date, period);
      const r = rows.get(key) || { period: key, haikus: 0, uses: Object.fromEntries(list.map(w => [w, 0])) };
      r.haikus++;
      for (const x of wordsOf(h)) for (const w of list) if (sameWord(x, w)) r.uses[w]++;
      rows.set(key, r);
    }
    const periods = [...rows.values()].sort((a, b) => (a.period < b.period ? -1 : 1)).map(r => ({
      ...r, per_100_haikus: Object.fromEntries(list.map(w => [w, round1(100 * r.uses[w] / r.haikus)])) }));
    const totals = Object.fromEntries(list.map(w => [w, periods.reduce((s, r) => s + r.uses[w], 0)]));
    return { period, words: list, totals, periods };
  }

  // The Archive page's per-engine stats, for any date range.
  function compareEngines(haikus, { from, to, top } = {}) {
    const hs = filterHaikus(haikus, { from, to });
    const n = clampLimit(top, 5, 20);
    const engines = ENGINES.map(e => {
      const es = hs.filter(h => engineOf(h) === e);
      if (!es.length) return null;
      const rest = hs.filter(h => engineOf(h) !== e);
      const mine = countWords(es), theirs = countWords(rest);
      // Words this engine leans on more than the others, by per-haiku rate (main.js distinctive()).
      const lean = rest.length ? [...mine.keys()]
        .filter(w => mine.get(w) + (theirs.get(w) || 0) >= 5)
        .map(w => [w, mine.get(w) / es.length - (theirs.get(w) || 0) / rest.length])
        .filter(x => x[1] > 0).sort(byUses).slice(0, n).map(x => x[0]) : [];
      const dates = es.map(h => h.date).sort();
      return {
        engine: e,
        haikus: es.length,
        first: dates[0],
        last: dates[dates.length - 1],
        unique_words: mine.size,
        words_per_haiku: round1(es.reduce((s, h) => s + wordsOf(h).length, 0) / es.length),
        top_words: [...mine.entries()].sort(byUses).slice(0, n).map(([word, uses]) => ({ word, uses })),
        distinctive_words: lean,
        unique_haikus_pct: Math.round(100 * new Set(es.map(normHaiku)).size / es.length),
        meter_575_pct: Math.round(100 * es.filter(is575).length / es.length),
        mood: moodAgg(es),
      };
    }).filter(Boolean);
    return { from: from || null, to: to || null, haikus: hs.length, engines };
  }

  function benchSection(bench, section) {
    if (section === "cloud") {
      return { haikus: bench.cloud.haikus, window_days: bench.window_days,
        words: bench.cloud.words.map(w => ({ word: w.word, uses: w.uses, family: w.owner || null, models: w.models })) };
    }
    if (section === "latest_run") {
      return { run: bench.latest_run, haikus: bench.haikus.map(h => ({ model: h.model, provider: h.provider,
        effort: h.effort || "default", lines: h.lines })) };
    }
    if (section === "models") {
      return { window_days: bench.window_days, runs: bench.runs_in_window,
        models: bench.models.map(m => ({ model: m.model, provider: m.provider, effort: m.effort || "default",
          family: m.lineage || null, used: m.asked, answered: m.ok, last_answer: m.last_ok })) };
    }
    throw new Error(`section must be one of ${BENCH_SECTIONS.join(", ")}`);
  }

  const asText = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

  // A tool that throws reaches the agent as Chrome's generic "invocation failed", without the
  // reason. Return the reason as an MCP error result so the agent can fix its input.
  async function respond(work) {
    try {
      return asText(await work());
    } catch (err) {
      return { content: [{ type: "text", text: String(err && err.message || err) }], isError: true };
    }
  }

  function tools(base) {
    const engine = { type: "string", enum: ENGINES, description: "Only haikus by this engine." };
    const from = { type: "string", format: "date", description: "Earliest date, YYYY-MM-DD (UTC)." };
    const to = { type: "string", format: "date", description: "Latest date, YYYY-MM-DD (UTC)." };
    const archive = (fn, input) => respond(async () => fn(await getJson("haiku.json"), input || {}, base));
    return [
      {
        name: "get_latest_haikus",
        description: "Get the most recent haikus from Daily Haiku, written four times a day by three "
          + "AI engines (claude, codex, agy). Returns each haiku's engine, UTC timestamp, three lines "
          + "and permalink, newest first.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 20, description: "How many haikus to return (default 3)." },
            engine,
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: input => archive(latestHaikus, input),
      },
      {
        name: "search_haikus",
        description: "Search the full Daily Haiku archive (every haiku since November 2025) by a word "
          + "or phrase, engine and date range. Returns the total number of matches and up to `limit` "
          + "of them, newest first, with permalinks.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Word or phrase to find in the haiku text, case-insensitive. Omit to match every haiku." },
            engine,
            from,
            to,
            limit: { type: "integer", minimum: 1, maximum: 50, description: "How many matches to return (default 10)." },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: input => archive(searchHaikus, input),
      },
      {
        name: "get_haikus_for_word",
        description: "Get the haikus that use one word as a whole word (so \"sea\" does not match "
          + "\"season\"; a possessive like \"winter's\" counts as \"winter\", a plural does not: find those "
          + "with search_by_word). Returns the total, the count "
          + "per engine and up to `limit` haikus with permalinks, newest or oldest first. For phrases "
          + "or word fragments use search_haikus.",
        inputSchema: {
          type: "object",
          properties: {
            word: { type: "string", description: "One word, case-insensitive, e.g. \"sparrow\"." },
            engine,
            from,
            to,
            order: { type: "string", enum: ORDERS, description: "newest first (default) or oldest first, e.g. to find the first use." },
            limit: { type: "integer", minimum: 1, maximum: 50, description: "How many haikus to return (default 10)." },
          },
          required: ["word"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: input => archive(haikusForWord, input),
      },
      {
        name: "search_by_word",
        description: "Look up words in the archive's vocabulary: every distinct word that starts with, "
          + "contains or exactly matches `query`, with how many times it was used, in how many haikus, "
          + "per engine, and the first and last date it appeared. Returns words, not haikus; use "
          + "get_haikus_for_word to read them.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "A word or the start of one, e.g. \"blos\" finds blossom, blossoms." },
            match: { type: "string", enum: Object.keys(MATCHES), description: "prefix (default), contains, or exact (the word and its possessive)." },
            engine,
            from,
            to,
            limit: { type: "integer", minimum: 1, maximum: 100, description: "How many words to return, most used first (default 20)." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: input => archive(searchByWord, input),
      },
      {
        name: "get_word_cloud",
        description: "Get the most-used words in the Daily Haiku archive (the three engines, not the "
          + "free-model bench), counted as on the Archive page: stopwords and words under three letters "
          + "are left out. Each word comes with its total uses and uses per engine. Filter by engine "
          + "and date range. For the bench's cloud use get_free_model_bench.",
        inputSchema: {
          type: "object",
          properties: {
            engine,
            from,
            to,
            limit: { type: "integer", minimum: 1, maximum: 100, description: "How many words to return, most used first (default 30)." },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: input => archive(wordCloud, input),
      },
      {
        name: "get_word_trends",
        description: "Track up to five words over time: uses per month or week, with that period's "
          + "haiku count and uses per 100 haikus, so periods with fewer haikus compare fairly. "
          + "Whole-word matching, as in get_haikus_for_word. Oldest period first.",
        inputSchema: {
          type: "object",
          properties: {
            words: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5,
              description: "One to five words, case-insensitive, e.g. [\"frost\", \"bloom\"]." },
            period: { type: "string", enum: PERIODS, description: "month (default, YYYY-MM) or week (the Monday's date)." },
            engine,
            from,
            to,
          },
          required: ["words"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: input => archive(wordTrends, input),
      },
      {
        name: "compare_engines",
        description: "Compare the three engines (claude, codex, agy) over a date range: haikus written, "
          + "vocabulary size, words per haiku, top words, words each leans on more than the others, "
          + "share of haikus that are unique, share that scan 5-7-5 (syllables estimated) and mood. "
          + "Mood is a lexical warm (+1) to cool (-1) lean with a 95% confidence interval, not true "
          + "sentiment; \"even\" means the interval doesn't clear zero.",
        inputSchema: {
          type: "object",
          properties: {
            from,
            to,
            top: { type: "integer", minimum: 1, maximum: 20, description: "How many top and distinctive words per engine (default 5)." },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: input => archive(compareEngines, input),
      },
      {
        name: "get_free_model_bench",
        description: "Get the Experimental free-model bench: every free model reachable through OmniRoute "
          + "writes a haiku to the same prompt four times a day. `cloud` gives the 80 most-used words "
          + "and the model family that leans on each; `latest_run` the last run's haikus with model, "
          + "provider and reasoning effort; `models` how often each model was used and answered.",
        inputSchema: {
          type: "object",
          properties: {
            section: { type: "string", enum: BENCH_SECTIONS, description: "Which part of the bench to return." },
          },
          required: ["section"],
          additionalProperties: false,
        },
        // Third-party free models wrote these haikus: treat the text as untrusted.
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: input => respond(async () => benchSection(await getJson("free-models.json"), (input || {}).section)),
      },
    ];
  }

  if (typeof document !== "undefined") {
    const mc = document.modelContext || (typeof navigator !== "undefined" && navigator.modelContext);
    if (mc && typeof mc.registerTool === "function") {
      for (const tool of tools(document.baseURI)) {
        try {
          Promise.resolve(mc.registerTool(tool)).catch(err => console.warn(`WebMCP ${tool.name}:`, err));
        } catch (err) {
          console.warn(`WebMCP ${tool.name}:`, err);
        }
      }
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { tools, respond, latestHaikus, searchHaikus, haikusForWord, searchByWord, wordCloud,
      wordTrends, compareEngines, benchSection, slugOf, tokens, moodRaw, moodAgg, is575 };
  }
})();
