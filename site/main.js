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

// Provider badge plus this haiku's own warm↔cool mood score (-1..+1).
function sourceBadge(h) {
  if (!h.source) return "";
  const v = moodOf(h);
  return `<span class="source-badge source-${h.source}">${h.source}</span>`
    + `<span class="mood">${v > 0 ? "+" : ""}${v.toFixed(1)}</span>`;
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
// are unscored, and a haiku's score is net warm/cool words over scored words.
const MOOD_WARM = new Set(("light dawn spring bloom blooms sun warms warm gold golden bright " +
  "green coffee wake wakes awakens waking soft softly steam breathes hums opens flows flow " +
  "fresh glow blossom cherry hope joy clear gentle alive sunlight daylight").split(" "));
const MOOD_COOL = new Set(("silent silence frost snow cold winter empty bare void dark shadow " +
  "fade fades falls fall descend descends drift drifts mist night lost alone gray grey still " +
  "sleeps sleep fading hollow ash dusk frozen freeze chill barren").split(" "));

function moodOf(h) {
  let net = 0, scored = 0;
  for (const l of h.lines) for (const w of l.toLowerCase().match(/[a-z']+/g) || []) {
    if (MOOD_WARM.has(w)) { net++; scored++; }
    else if (MOOD_COOL.has(w)) { net--; scored++; }
  }
  return scored ? net / scored : 0;   // -1 (cool) .. +1 (warm)
}

function moodAgg(arr) {
  if (!arr.length) return null;
  const mean = arr.reduce((s, h) => s + moodOf(h), 0) / arr.length;
  return { n: arr.length, score: Math.round(mean * 100) / 100,
    label: mean > 0.15 ? "warm" : mean < -0.15 ? "cool" : "even" };
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
    out.push(`Across ${s.total} haikus the mood lands ${s.moodAll.label} (${s.moodAll.score} on a cool-to-warm scale).`);
  if (s.mood.length >= 2 && s.mood[0].label !== s.mood[s.mood.length - 1].label) {
    const warm = s.mood[0], cool = s.mood[s.mood.length - 1];
    out.push(`Their moods split — ${cool.src} writes cool (${cool.score}); ${warm.src} warm (+${warm.score}).`);
  }
  return out;
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
      cells.push(`mood (cool −1…+1 warm) — ${s.mood.map(m => `${m.src} ${m.score > 0 ? "+" : ""}${m.score}`).join(" · ")}`);
    }
    // Only note the basis when some haikus are still unattributed.
    const note = s.dist && s.attributed < s.total
      ? `<span class="stat-note">among ${s.attributed} attributed haikus</span>` : "";
    strip.innerHTML = cells.map(c => `<span class="stat-cell">${c}</span>`).join("") + note;
  }
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
