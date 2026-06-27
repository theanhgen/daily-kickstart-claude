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

// Group consecutive haikus into pairs if different sources within 120s
function pairUp(haikus) {
  const out = [];
  let i = 0;
  while (i < haikus.length) {
    const a = haikus[i], b = haikus[i + 1];
    if (b && a.source && b.source && a.source !== b.source
        && Math.abs(tsMs(a.timestamp) - tsMs(b.timestamp)) <= 120000) {
      const claude = a.source === "claude" ? a : b;
      const codex  = a.source === "codex"  ? a : b;
      out.push({ type: "pair", claude, codex });
      i += 2;
    } else {
      out.push({ type: "single", haiku: a });
      i++;
    }
  }
  return out;
}

function haikuLines(h) {
  return h.lines.map(l => `<p>${l}</p>`).join("");
}

function renderMain(haikus) {
  const container = document.getElementById("main-content");
  const items = pairUp(haikus.slice(0, 2));
  const first = items[0];

  if (first.type === "pair") {
    container.innerHTML = `
      <div class="main-pair">
        <div class="pair-col">
          <div class="haiku loaded">${haikuLines(first.claude)}</div>
          <span class="source-badge source-claude">claude</span>
        </div>
        <div class="pair-col">
          <div class="haiku loaded">${haikuLines(first.codex)}</div>
          <span class="source-badge source-codex">codex</span>
        </div>
      </div>
      <div class="haiku-date">${formatDate(first.claude.date)}</div>`;
  } else {
    const h = first.haiku;
    container.innerHTML = `
      <span class="haiku-kicker">${formatDate(h.date)}</span>
      <div class="haiku loaded">${haikuLines(h)}</div>
      ${h.source ? `<div class="haiku-rule"></div><div class="haiku-meta"><span class="source-badge source-${h.source}">${h.source}</span></div>` : ""}`;
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
      const items = pairUp(entries);
      const rows = items.map(item => {
        if (item.type === "pair") {
          return `
            <div class="haiku-entry haiku-entry-pair">
              <div class="pair-col">
                ${haikuLines(item.claude)}
                <div class="entry-meta">
                  <span class="time">${formatDate(item.claude.date)}</span>
                  <span class="source-badge source-claude">claude</span>
                </div>
              </div>
              <div class="pair-col">
                ${haikuLines(item.codex)}
                <div class="entry-meta">
                  <span class="time">${formatDate(item.codex.date)}</span>
                  <span class="source-badge source-codex">codex</span>
                </div>
              </div>
            </div>`;
        }
        const h = item.haiku;
        return `
          <div class="haiku-entry">
            ${haikuLines(h)}
            <div class="entry-meta">
              <span class="time">${formatDate(h.date)}</span>
              ${h.source ? `<span class="source-badge source-${h.source}">${h.source}</span>` : ""}
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

  return {
    total,
    uniqueWords: all.size,
    topWord: topN(all, 1)[0],
    attributed: haikus.filter(h => h.source).length,
    dist,
    topOpen: topOpen.map(x => x[0]),
    openPct,
    missing: ["spring", "summer", "autumn", "winter"].filter(s => !all.get(s)),
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
    // Only note the basis when some haikus are still unattributed.
    const note = s.dist && s.attributed < s.total
      ? `<span class="stat-note">among ${s.attributed} attributed haikus</span>` : "";
    strip.innerHTML = cells.map(c => `<span class="stat-cell">${c}</span>`).join("") + note;
  }
}

(async () => {
  try {
    const haikus = await loadHaikus();
    if (document.getElementById("main-content")) renderMain(haikus);
    if (document.getElementById("archive-content")) renderArchive(haikus);
    renderInsights(haikus);
  } catch {
    const el = document.getElementById("main-content") || document.getElementById("archive-content");
    if (el) el.innerHTML = "<p>—</p>";
  }
})();
