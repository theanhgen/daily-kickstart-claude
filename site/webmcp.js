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
    return { engine: h.source || "claude", timestamp: h.timestamp, lines: h.lines,
      url: new URL(`h/${slugOf(h)}/`, base).href };
  }

  // haiku.json is newest first.
  function latestHaikus(haikus, { limit, engine } = {}, base = "https://example.invalid/") {
    return haikus.filter(h => !engine || (h.source || "claude") === engine)
      .slice(0, clampLimit(limit, 3, 20)).map(h => shapeHaiku(h, base));
  }

  function searchHaikus(haikus, { query, engine, from, to, limit } = {}, base = "https://example.invalid/") {
    const q = (query || "").trim().toLowerCase();
    const hits = haikus.filter(h => (!engine || (h.source || "claude") === engine)
      && (!from || h.date >= from) && (!to || h.date <= to)
      && (!q || h.lines.join(" ").toLowerCase().includes(q)));
    return { total: hits.length, haikus: hits.slice(0, clampLimit(limit, 10, 50)).map(h => shapeHaiku(h, base)) };
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

  function tools(base) {
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
            engine: { type: "string", enum: ENGINES, description: "Only haikus by this engine." },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async input => asText(latestHaikus(await getJson("haiku.json"), input, base)),
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
            engine: { type: "string", enum: ENGINES, description: "Only haikus by this engine." },
            from: { type: "string", format: "date", description: "Earliest date, YYYY-MM-DD (UTC)." },
            to: { type: "string", format: "date", description: "Latest date, YYYY-MM-DD (UTC)." },
            limit: { type: "integer", minimum: 1, maximum: 50, description: "How many matches to return (default 10)." },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async input => asText(searchHaikus(await getJson("haiku.json"), input, base)),
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
        execute: async ({ section }) => asText(benchSection(await getJson("free-models.json"), section)),
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
    module.exports = { tools, latestHaikus, searchHaikus, benchSection, slugOf };
  }
})();
