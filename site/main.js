async function loadHaikus() {
  const res = await fetch("haiku.json");
  if (!res.ok) throw new Error("haiku.json not found");
  return res.json();
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function formatMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    year: "numeric", month: "long",
  });
}

function tsMs(ts) {
  return new Date(ts.replace(" ", "T").replace(" UTC", "Z")).getTime();
}

// Engines in display order; haikus from one cron cycle are shown together.
const ENGINE_ORDER = { claude: 0, codex: 1, agy: 2 };
const CYCLE_WINDOW_MS = 10 * 60 * 1000;   // a cycle's engines all land within minutes

function orderByEngine(hs) {
  return [...hs].sort((a, b) => (ENGINE_ORDER[a.source] ?? 9) - (ENGINE_ORDER[b.source] ?? 9));
}

// Group consecutive haikus from the same cron cycle: distinct engines, close
// in time. Handles 2 (claude+codex) or 3 (claude+codex+agy) per cycle.
function groupCycle(haikus) {
  const out = [];
  let i = 0;
  while (i < haikus.length) {
    const sources = new Set(haikus[i].source ? [haikus[i].source] : []);
    let j = i + 1;
    while (haikus[i].source && j < haikus.length && haikus[j].source
        && !sources.has(haikus[j].source)
        && Math.abs(tsMs(haikus[j].timestamp) - tsMs(haikus[j - 1].timestamp)) <= CYCLE_WINDOW_MS) {
      sources.add(haikus[j].source);
      j++;
    }
    if (j - i > 1) { out.push({ type: "cycle", haikus: orderByEngine(haikus.slice(i, j)) }); i = j; }
    else { out.push({ type: "single", haiku: haikus[i] }); i++; }
  }
  return out;
}

function haikuLines(h) {
  return h.lines.map(l => `<p>${l}</p>`).join("");
}

// Provider badge plus this haiku's own warm↔cool mood score (-1..+1). The score
// is faded when it rests on fewer than two lexicon words — low confidence, so it
// should read as tentative rather than as a precise measurement.
function sourceBadge(h) {
  if (!h.source) return "";
  const m = moodRaw(h);
  const weak = m.scored < 2 ? " mood-weak" : "";
  const title = `${m.scored} scored word${m.scored === 1 ? "" : "s"}`;
  return `<span class="source-badge source-${h.source}">${h.source}</span>`
    + `<span class="mood${weak}" title="${title}">${m.score > 0 ? "+" : ""}${m.score.toFixed(2)}</span>`;
}

function renderMain(haikus) {
  const container = document.getElementById("main-content");
  const first = groupCycle(haikus.slice(0, 3))[0];

  if (first.type === "cycle") {
    container.innerHTML = `
      <div class="main-cycle cols-${first.haikus.length}">
        ${first.haikus.map(h => `
        <div class="pair-col">
          <div class="haiku loaded">${haikuLines(h)}</div>
          <div class="haiku-meta">${sourceBadge(h)}</div>
        </div>`).join("")}
      </div>
      <div class="haiku-date">${formatDate(first.haikus[0].date)}</div>`;
  } else {
    const h = first.haiku;
    container.innerHTML = `
      <span class="haiku-kicker">${formatDate(h.date)}</span>
      <div class="haiku loaded">${haikuLines(h)}</div>
      ${h.source ? `<div class="haiku-rule"></div><div class="haiku-meta">${sourceBadge(h)}</div>` : ""}`;
  }
}

function renderArchive(haikus) {
  const count = document.getElementById("haiku-count");
  if (count) count.textContent = `${haikus.length} haikus`;

  const byMonth = {};
  for (const h of haikus) {
    const key = h.date.slice(0, 7);
    (byMonth[key] ??= []).push(h);
  }

  document.getElementById("archive-content").innerHTML = Object.entries(byMonth)
    .map(([monthKey, entries]) => {
      const items = groupCycle(entries);
      const rows = items.map(item => {
        if (item.type === "cycle") {
          return `
            <div class="haiku-entry haiku-entry-cycle cols-${item.haikus.length}">
              ${item.haikus.map(h => `
              <div class="pair-col">
                ${haikuLines(h)}
                <div class="entry-meta">
                  <span class="time">${formatDate(h.date)}</span>
                  ${sourceBadge(h)}
                </div>
              </div>`).join("")}
            </div>`;
        }
        const h = item.haiku;
        return `
          <div class="haiku-entry">
            ${haikuLines(h)}
            <div class="entry-meta">
              <span class="time">${formatDate(h.date)}</span>
              ${sourceBadge(h)}
            </div>
          </div>`;
      }).join("");
      return `
        <div class="month-group">
          <h2 class="month-heading">${formatMonth(monthKey)}</h2>
          <span class="month-count">${entries.length} haiku</span>
          <div class="month-entries">${rows}</div>
        </div>`;
    }).join("");
}

// ── Live archive analysis — recomputed from the data on every load ──

const STOP = new Set(("the a an and or but of to in on at by for with from into as is are was " +
  "be it its his her their our your my this that these those then than so no not all each").split(" "));

function tokens(h) {
  const out = [];
  for (const line of h.lines) {
    for (const w of line.toLowerCase().match(/[a-z']+/g) || []) {
      if (w.length > 2 && !STOP.has(w)) out.push(w);
    }
  }
  return out;
}

function countWords(haikus) {
  const c = new Map();
  for (const h of haikus) for (const w of tokens(h)) c.set(w, (c.get(w) || 0) + 1);
  return c;
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// Words that lean toward engine A vs B, by normalized frequency gap.
function distinctive(a, na, b, nb, n) {
  const scored = [];
  for (const w of new Set([...a.keys(), ...b.keys()])) {
    const av = a.get(w) || 0, bv = b.get(w) || 0;
    if (av + bv >= 5) scored.push([w, av / na - bv / nb]);
  }
  scored.sort((x, y) => y[1] - x[1]);
  return { a: scored.slice(0, n).map(x => x[0]), b: scored.slice(-n).reverse().map(x => x[0]) };
}

const ENGINES = ["claude", "codex", "agy"];
const MIN_ENGINE_HAIKUS = 25;   // an engine joins per-engine rankings once it clears this

// A haiku's identity for repetition detection — lowercased, trimmed lines.
function normHaiku(h) {
  return h.lines.map(l => l.toLowerCase().trim()).join(" / ");
}

// Mood = a curated warm↔cool lean over the corpus's actual imagery. It's a
// lexical heuristic, not true sentiment — neutral/technical words (code, keys)
// are unscored. A haiku's raw lean is net(warm−cool) words, then shrunk toward
// neutral by MOOD_K so a haiku resting on a single word can't slam to ±1 (thin
// evidence → near-zero). A short negation window flips polarity after no/not.
const MOOD_WARM = new Set(("light dawn spring bloom blooms sun warms warm gold golden bright " +
  "green coffee wake wakes awakens waking soft softly steam breathes hums opens flows flow " +
  "fresh glow blossom cherry hope joy clear gentle alive sunlight daylight").split(" "));
const MOOD_COOL = new Set(("silent silence frost snow cold winter empty bare void dark shadow " +
  "fade fades falls fall descend descends drift drifts mist night lost alone gray grey still " +
  "sleeps sleep fading hollow ash dusk frozen freeze chill barren").split(" "));
const MOOD_NEG = new Set("not no never without nor none cannot".split(" "));
const MOOD_K = 2;   // shrinkage strength: thin evidence pulls toward neutral

// Returns { score:-1..+1, scored, net }. score is the shrunk lean; scored is
// how many lexicon words backed it (the per-haiku confidence).
function moodRaw(h) {
  let net = 0, scored = 0;
  for (const l of h.lines) {
    let negLeft = 0;   // negation reach, in tokens; does not cross lines
    for (const w of l.toLowerCase().match(/[a-z']+/g) || []) {
      if (MOOD_NEG.has(w)) { negLeft = 3; continue; }
      const s = MOOD_WARM.has(w) ? 1 : MOOD_COOL.has(w) ? -1 : 0;
      if (s) { net += negLeft > 0 ? -s : s; scored++; }
      if (negLeft > 0) negLeft--;
    }
  }
  return { score: scored ? net / (scored + MOOD_K) : 0, scored, net };
}

function moodOf(h) { return moodRaw(h).score; }

// Aggregate with a 95% CI (mean ± 1.96·sd/√n). Label only when the interval
// clears a small deadband around zero; otherwise the lean isn't significant.
function moodAgg(arr) {
  if (!arr.length) return null;
  const xs = arr.map(moodOf);
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const ci = n > 1 ? 1.96 * sd / Math.sqrt(n) : 0;
  const r2 = v => Math.round(v * 100) / 100;
  const label = mean - ci > 0.03 ? "warm" : mean + ci < -0.03 ? "cool" : "even";
  return { n, score: r2(mean), ci: r2(ci), lo: r2(mean - ci), hi: r2(mean + ci), label };
}

function computeStats(haikus) {
  const total = haikus.length;
  const all = countWords(haikus);
  const claude = haikus.filter(h => h.source === "claude");
  const codex = haikus.filter(h => h.source === "codex");
  const dist = claude.length && codex.length
    ? distinctive(countWords(claude), claude.length, countWords(codex), codex.length, 4)
    : null;

  const openings = new Map();
  for (const h of haikus) {
    const w = (h.lines[0].toLowerCase().match(/[a-z']+/) || [""])[0];
    if (w) openings.set(w, (openings.get(w) || 0) + 1);
  }
  const topOpen = topN(openings, 3);
  const openPct = Math.round(100 * topOpen.reduce((s, x) => s + x[1], 0) / total);

  // Per-engine originality = share of an engine's haikus that are unique.
  const originality = ENGINES.map(src => {
    const es = haikus.filter(h => h.source === src);
    const distinct = new Set(es.map(normHaiku)).size;
    return { src, n: es.length, pct: es.length ? Math.round(100 * distinct / es.length) : 0 };
  }).filter(o => o.n > 0);

  // The single most-written haiku across the whole archive.
  const counts = new Map();
  for (const h of haikus) { const k = normHaiku(h); counts.set(k, (counts.get(k) || 0) + 1); }
  let mostWritten = null;
  for (const h of haikus) {
    const c = counts.get(normHaiku(h));
    if (!mostWritten || c > mostWritten.count) mostWritten = { count: c, firstLine: h.lines[0] };
  }

  return {
    total,
    uniqueWords: all.size,
    topWord: topN(all, 1)[0],
    attributed: haikus.filter(h => h.source).length,
    dist,
    topOpen: topOpen.map(x => x[0]),
    openPct,
    missing: ["spring", "summer", "autumn", "winter"].filter(s => !all.get(s)),
    originality,
    ranked: originality.filter(o => o.n >= MIN_ENGINE_HAIKUS).sort((a, b) => b.pct - a.pct),
    mostWritten,
    moodAll: moodAgg(haikus),
    mood: ENGINES.map(src => ({ src, ...moodAgg(haikus.filter(h => h.source === src)) }))
      .filter(m => m.n >= MIN_ENGINE_HAIKUS).sort((a, b) => b.score - a.score),
  };
}

// Candidate headline lines — only those currently true for the data.
function heroLines(s) {
  const out = [];
  if (s.missing.length)
    out.push(`In ${s.total} haikus, not one has ever mentioned ${s.missing[0]}.`);
  if (s.openPct >= 40 && s.topOpen.length === 3)
    out.push(`${s.openPct}% of haikus open with “${s.topOpen[0]},” “${s.topOpen[1]},” or “${s.topOpen[2]}.”`);
  if (s.dist)
    out.push(`claude reaches for ${s.dist.a.slice(0, 2).join(" and ")}; codex for ${s.dist.b.slice(0, 2).join(" and ")}.`);
  if (s.topWord)
    out.push(`Their most-loved image — ${s.topWord[0]}, written ${s.topWord[1]} times.`);
  if (s.ranked.length >= 2) {
    const most = s.ranked[0], least = s.ranked[s.ranked.length - 1];
    out.push(`${most.src} almost never repeats itself — ${most.pct}% of its haikus are unique; ${least.src} returns to its favorites (${least.pct}%).`);
  }
  if (s.mostWritten && s.mostWritten.count >= 3)
    out.push(`One haiku has been written ${s.mostWritten.count} times: “${s.mostWritten.firstLine}…”`);
  if (s.moodAll)
    out.push(`Across ${s.total} haikus the mood lands ${s.moodAll.label} (${s.moodAll.score > 0 ? "+" : ""}${s.moodAll.score} ±${s.moodAll.ci}, cool-to-warm).`);
  if (s.mood.length >= 2) {
    const warm = s.mood[0], cool = s.mood[s.mood.length - 1];
    if (warm.label === "warm" && cool.label === "cool")
      out.push(`Their moods split — ${cool.src} writes cool (${cool.score} ±${cool.ci}); ${warm.src} warm (+${warm.score} ±${warm.ci}).`);
  }
  return out;
}

const DAY_MS = 86400000;

// Daily mean mood per engine over the last `days`, anchored to the newest
// haiku so the axis tracks the data even if the page is opened later. Returns
// src -> [{ day, mean, n }] for the days that engine actually wrote on.
function moodTrend(haikus, days) {
  const out = new Map(ENGINES.map(src => [src, []]));
  if (!haikus.length) return out;
  const anchor = haikus.reduce((m, h) => Math.max(m, tsMs(h.timestamp)), 0);
  const start = anchor - (days - 1) * DAY_MS;
  for (const src of ENGINES) {
    const byDay = new Map();
    for (const h of haikus) {
      if (h.source !== src) continue;
      const t = tsMs(h.timestamp);
      if (t < start) continue;
      const day = Math.floor((t - start) / DAY_MS);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(moodOf(h));
    }
    out.set(src, [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(
      ([day, xs]) => ({ day, mean: xs.reduce((s, x) => s + x, 0) / xs.length, n: xs.length })));
  }
  return out;
}

// Centered rolling mean over ±win days — smooths daily jitter so three
// overlaid engine lines stay legible without hiding the real trend.
function smooth(series, win) {
  return series.map(p => {
    let s = 0, c = 0;
    for (const q of series) if (Math.abs(q.day - p.day) <= win) { s += q.mean; c++; }
    return { day: p.day, mean: s / c };
  });
}

// Monotone-ish smooth path (Catmull-Rom → cubic bézier), like a recharts
// type="monotone" line. Dense smoothed data keeps overshoot negligible.
function smoothPath(pts) {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0].px},${pts[0].py} L${pts[1].px},${pts[1].py}`;
  let d = `M${pts[0].px.toFixed(1)},${pts[0].py.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1.px + (p2.px - p0.px) / 6, c1y = p1.py + (p2.py - p0.py) / 6;
    const c2x = p2.px - (p3.px - p1.px) / 6, c2y = p2.py - (p3.py - p1.py) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.px.toFixed(1)},${p2.py.toFixed(1)}`;
  }
  return d;
}

// A shadcn/recharts-style card: bordered card, header (title + legend),
// horizontal-only gridlines, smooth monotone curves in each engine's own
// colour, month ticks, a hover tooltip, and a footer trend line. All three
// engines share one −0.8…+0.8 axis so they compare directly.
function renderTrend(haikus) {
  const el = document.getElementById("archive-trend");
  if (!el) return;
  const days = 90;
  const trend = moodTrend(haikus, days);
  const anchor = haikus.reduce((m, h) => Math.max(m, tsMs(h.timestamp)), 0);
  const startMs = anchor - (days - 1) * DAY_MS;
  const W = 620, H = 170, PL = 8, PR = 8, PT = 12, PB = 22, R = 0.8;
  const x = d => PL + (days < 2 ? 0 : d / (days - 1)) * (W - PL - PR);
  const y = v => PT + (1 - (Math.max(-R, Math.min(R, v)) + R) / (2 * R)) * (H - PT - PB);

  // Horizontal gridlines only (CartesianGrid vertical={false}); zero emphasised.
  let grid = "";
  for (const g of [0.4, 0, -0.4]) {
    grid += `<line x1="${PL}" y1="${y(g).toFixed(1)}" x2="${W - PR}" y2="${y(g).toFixed(1)}" class="${g === 0 ? "spark-zero" : "spark-grid"}"/>`
      + `<text x="${PL}" y="${(y(g) - 3).toFixed(1)}" class="spark-glabel">${g > 0 ? "+" : ""}${g}</text>`;
  }

  // Month ticks along the x-axis.
  let xticks = "";
  let lastMonth = -1;
  for (let d = 0; d < days; d++) {
    const dt = new Date(startMs + d * DAY_MS);
    if (dt.getMonth() !== lastMonth) {
      lastMonth = dt.getMonth();
      if (d > 2 && d < days - 2)
        xticks += `<text x="${x(d).toFixed(1)}" y="${H - 6}" class="spark-xlabel" text-anchor="middle">${dt.toLocaleDateString("en-US", { month: "short" })}</text>`;
    }
  }

  // One smooth line per engine, in its own colour; plus a per-day value lookup
  // (nearest smoothed point) the hover tooltip reads from.
  let lines = "";
  const legend = [], lookup = {};
  for (const src of ENGINES) {
    const raw = trend.get(src);
    const ser = smooth(raw, 3);
    const arr = new Array(days).fill(null);
    for (const p of ser) if (p.day >= 0 && p.day < days) arr[p.day] = p.mean;
    lookup[src] = arr;
    if (!raw.length) continue;
    legend.push({ src, last: raw[raw.length - 1].mean });
    if (ser.length >= 2)
      lines += `<path d="${smoothPath(ser.map(p => ({ px: x(p.day), py: y(p.mean) })))}" fill="none" stroke="var(--${src}-text)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const lp = ser[ser.length - 1];
    lines += `<circle cx="${x(lp.day).toFixed(1)}" cy="${y(lp.mean).toFixed(1)}" r="2.5" fill="var(--${src}-text)"/>`;
  }

  const leg = legend.map(l =>
    `<span class="trend-key"><i style="background:var(--${l.src}-text)"></i>${l.src} ${l.last > 0 ? "+" : ""}${l.last.toFixed(2)}</span>`).join("");

  // Footer trend: change in the all-engine daily mean, last 30 vs prior 30 days.
  const allByDay = new Map();
  for (const h of haikus) {
    if (!h.source) continue;
    const t = tsMs(h.timestamp);
    if (t < startMs) continue;
    const d = Math.floor((t - startMs) / DAY_MS);
    if (!allByDay.has(d)) allByDay.set(d, []);
    allByDay.get(d).push(moodOf(h));
  }
  const dayMean = d => { const a = allByDay.get(d); return a ? a.reduce((s, v) => s + v, 0) / a.length : null; };
  const windowMean = (lo, hi) => {
    let s = 0, c = 0;
    for (let d = lo; d < hi; d++) { const m = dayMean(d); if (m != null) { s += m; c++; } }
    return c ? s / c : null;
  };
  const recent = windowMean(days - 30, days), prior = windowMean(days - 60, days - 30);
  const delta = recent != null && prior != null ? recent - prior : 0;
  const up = delta >= 0;
  const icon = up
    ? `<svg viewBox="0 0 24 24" class="trend-icon"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`
    : `<svg viewBox="0 0 24 24" class="trend-icon"><polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/></svg>`;
  const foot = `Mood ${up ? "warming" : "cooling"} ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(2)} over the last 30 days ${icon}`;
  const fmt = ms => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  el.innerHTML =
    `<div class="chart-card">
      <div class="chart-head">
        <div><div class="chart-title">Sentiment</div><div class="chart-desc">daily mood · ${fmt(startMs)} – ${fmt(anchor)}</div></div>
        <div class="trend-legend">${leg}</div>
      </div>
      <div class="chart-body">
        <svg viewBox="0 0 ${W} ${H}" class="trend-chart">${grid}${xticks}${lines}
          <line class="chart-cursor" x1="0" y1="${PT}" x2="0" y2="${H - PB}" style="display:none"/>
        </svg>
        <div class="chart-tip" hidden></div>
        <div class="chart-hot" style="left:${(PL / W * 100).toFixed(2)}%;right:${(PR / W * 100).toFixed(2)}%"></div>
      </div>
      <div class="chart-foot"><div class="chart-foot-main">${foot}</div><div class="chart-foot-sub">cool below the line · warm above · shared −0.8…+0.8 scale</div></div>
    </div>`;

  // Hover tooltip + cursor.
  const svg = el.querySelector(".trend-chart");
  const cursor = el.querySelector(".chart-cursor");
  const tip = el.querySelector(".chart-tip");
  const hot = el.querySelector(".chart-hot");
  const valAt = (src, day) => {
    const a = lookup[src];
    for (let r = 0; r <= 5; r++) { if (a[day - r] != null) return a[day - r]; if (a[day + r] != null) return a[day + r]; }
    return null;
  };
  hot.addEventListener("pointermove", e => {
    const rect = hot.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const day = Math.round(f * (days - 1));
    cursor.setAttribute("x1", x(day)); cursor.setAttribute("x2", x(day));
    cursor.style.display = "";
    const rows = ENGINES.map(src => ({ src, v: valAt(src, day) }))
      .filter(r => r.v != null)
      .sort((a, b) => b.v - a.v)   // warmest provider on top
      .map(r => `<div class="tip-row"><span class="tip-name"><i style="background:var(--${r.src}-text)"></i>${r.src}</span><b>${r.v > 0 ? "+" : ""}${r.v.toFixed(2)}</b></div>`)
      .join("");
    tip.innerHTML = `<div class="tip-date">${fmt(startMs + day * DAY_MS)}</div>${rows}`;
    tip.hidden = false;
    const body = hot.parentElement.getBoundingClientRect();
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(body.width - tw, e.clientX - body.left - tw / 2)) + "px";
  });
  hot.addEventListener("pointerleave", () => { tip.hidden = true; cursor.style.display = "none"; });
}

function renderInsights(haikus) {
  if (!haikus.length) return;
  const s = computeStats(haikus);

  const main = document.getElementById("main-insight");
  if (main) {
    const lines = heroLines(s);
    const now = new Date();
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    main.textContent = lines[doy % lines.length];   // rotates daily over live insights
  }

  const strip = document.getElementById("archive-stats");
  if (strip) {
    const cells = [
      `${s.uniqueWords} unique words · ${s.total} haikus`,
      `most-loved image — ${s.topWord[0]}`,
    ];
    if (s.dist) {
      cells.push(`claude’s world — ${s.dist.a.join(" · ")}`);
      cells.push(`codex’s world — ${s.dist.b.join(" · ")}`);
    }
    if (s.ranked.length >= 2) {
      const warming = s.originality.filter(o => o.n < MIN_ENGINE_HAIKUS);
      cells.push(`originality — ${s.ranked.map(o => `${o.src} ${o.pct}%`).join(" · ")}`
        + (warming.length ? ` (${warming.map(o => `${o.src} ${o.n}`).join(", ")} warming up)` : ""));
    }
    if (s.mood.length >= 2) {
      cells.push(`mood (cool −1…+1 warm, 95% CI) — ${s.mood.map(m => `${m.src} ${m.score > 0 ? "+" : ""}${m.score}±${m.ci}`).join(" · ")}`);
    }
    // Only note the basis when some haikus are still unattributed.
    const note = s.dist && s.attributed < s.total
      ? `<span class="stat-note">among ${s.attributed} attributed haikus</span>` : "";
    strip.innerHTML = cells.map(c => `<span class="stat-cell">${c}</span>`).join("") + note;
  }

  renderTrend(haikus);
}

// Fit a whole cycle to ONE shared font size so every haiku in it matches.
// Lines never wrap (CSS nowrap); we shrink all of them uniformly by the
// worst-case column, so they stay on exactly three rows without overlapping.
// Measure against each COLUMN's width — the inner block grows to the text,
// so it can't be the reference.
function fitCycle(cycle) {
  const ps = cycle.querySelectorAll("p");
  if (!ps.length) return;
  ps.forEach(p => { p.style.fontSize = ""; });          // reset to CSS default
  let scale = 1;
  cycle.querySelectorAll(".pair-col").forEach(col => {
    const cs = getComputedStyle(col);
    const avail = col.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (avail <= 0) return;
    col.querySelectorAll("p").forEach(p => {
      if (p.scrollWidth > avail) scale = Math.min(scale, avail / p.scrollWidth);
    });
  });
  if (scale < 1) {
    const base = parseFloat(getComputedStyle(ps[0]).fontSize);
    const size = Math.max(9, base * scale * 0.96);
    ps.forEach(p => { p.style.fontSize = size + "px"; });
  }
}

// Only the side-by-side cycle columns are narrow enough to need fitting.
function fitCycles() {
  document.querySelectorAll(".main-cycle, .haiku-entry-cycle").forEach(fitCycle);
}

(async () => {
  try {
    const haikus = await loadHaikus();
    if (document.getElementById("main-content")) renderMain(haikus);
    if (document.getElementById("archive-content")) renderArchive(haikus);
    renderInsights(haikus);
    fitCycles();
    // Re-fit once web fonts load — first pass measures with fallback metrics.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitCycles);
    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(fitCycles, 150); });
  } catch {
    const el = document.getElementById("main-content") || document.getElementById("archive-content");
    if (el) el.innerHTML = "<p>—</p>";
  }
})();
