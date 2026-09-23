// Experimental page: the free-model bench (scripts/omniroute-haiku.py). The Mac
// pushes free-models.json to the bench-data branch; the Pages deploy copies it in.
// Standalone on purpose: main.js would fetch haiku.json and draw the archive.

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// "agy/gemini-3.7-flash-high" -> "gemini-3.7-flash": the provider and the effort
// get their own badges, so the name drops both.
function benchName(model, provider) {
  const name = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  return name.replace(/-(xhigh|high|medium|low|minimal|none)(?=(:[\w.-]+)?$)/, "");
}

// "2026-09-18 06:01:00 UTC" -> "Sep 18, 06:01 UTC"
function fmtUtc(ts) {
  const [date, time] = ts.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US",
    { month: "short", day: "numeric", timeZone: "UTC" });
  return `${day}, ${time.slice(0, 5)} UTC`;
}

function badges(item) {
  return `<span class="source-badge">${esc(item.provider)}</span>`
    + `<span class="bench-model">${esc(benchName(item.model, item.provider))}</span>`
    + `<span class="source-badge" title="reasoning effort">${esc(item.effort || "default")}</span>`;
}

// ── Word cloud ──
// One text colour per family, [light, dark], fixed BY NAME so a word keeps its colour
// when the families reshuffle. Covers every lineage the multireview runner names, so
// a family that starts leaning on words isn't grey. Picked greedily in this order, each
// the hue farthest (OKLab) from all before it and from the grey and ink, at 4.5:1 or
// better on both backgrounds: the first ones get the widest gaps. Past about three
// hues a cloud can't separate every pair by colour alone (every colour sits next to
// every other, and several pairs merge for colour-blind readers), so the legend key,
// which lights a family's words, and the caption are the backup. "other" (unclassified)
// stays grey: it is a mix of families, not one.
const FAMILY_COLOURS = {
  gemini:    ["#2168c0", "#3987e5"],
  mistral:   ["#c9531f", "#d95926"],
  llama:     ["#0f8a5f", "#199e70"],
  liquid:    ["#8c51d9", "#a167f1"],
  ling:      ["#435d04", "#8ab627"],
  nemotron:  ["#93158e", "#f178e9"],
  "gpt-oss": ["#cd3482", "#db428e"],
  claude:    ["#8a0700", "#f19f91"],
  granite:   ["#373974", "#afb7fe"],
  cohere:    ["#864260", "#c97e9c"],
  poolside:  ["#804b0d", "#e7890f"],
  qwen:      ["#601194", "#8e6fae"],
  solar:     ["#91619a", "#f5c1fe"],
  deepseek:  ["#4835cd", "#8e95d9"],
  kimi:      ["#b81839", "#fe6270"],
  glm:       ["#b938bc", "#c646c9"],
  dots:      ["#055a85", "#19affe"],
  longcat:   ["#6b2362", "#db9cd0"],
  stepfun:   ["#037c9a", "#4ad5fe"],
  agnes:     ["#71782b", "#d2df1b"],
  minimax:   ["#6b4697", "#c191ff"],
  tencent:   ["#094a1a", "#3de765"],
  phi:       ["#a5595d", "#b46669"],
  gpt:       ["#1f790c", "#9fd396"],
};
const CLOUD_MIN_REM = 0.85;
const CLOUD_MAX_REM = 2.6;

function familyClass(owner) {
  if (!owner) return "shared";
  return FAMILY_COLOURS[owner] ? owner : "other";
}

// The class list and colour variables for a word or legend key; style.css picks the
// light or dark one.
function famAttrs(family) {
  const c = FAMILY_COLOURS[family];
  return c ? { cls: `fam-${family} fam-c`, vars: `;--fam-l:${c[0]};--fam-d:${c[1]}` }
    : { cls: `fam-${family === "shared" ? "shared" : familyClass(family)}`, vars: "" };
}

// Stable scatter: order words by a string hash, so big and small interleave the
// same way on every load instead of reading as a sorted list.
function wordHash(w) {
  let h = 2166136261;
  for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// Area, not height, should track uses: size by the square root.
function cloudSize(uses, min, max) {
  if (max === min) return (CLOUD_MIN_REM + CLOUD_MAX_REM) / 2;
  return CLOUD_MIN_REM + (CLOUD_MAX_REM - CLOUD_MIN_REM) * Math.sqrt((uses - min) / (max - min));
}

function familyLabel(f) {
  return f === "shared" ? "shared by all" : f === "other" ? "unclassified" : f;
}

// Every family that leans on at least one word, with how many, most first (colour is
// by name, so the order can follow the counts), then the words nobody leans on.
function cloudLegend(words) {
  const counts = new Map();
  for (const w of words) counts.set(w.owner || "shared", (counts.get(w.owner || "shared") || 0) + 1);
  const families = [...counts.keys()].filter(f => f !== "shared")
    .sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1));
  return [...families, ...(counts.has("shared") ? ["shared"] : [])].map(f => [f, counts.get(f)]);
}

function familyDetail(words, f) {
  const mine = words.filter(w => (w.owner || "shared") === f).map(w => w.word);
  if (f === "shared") return `shared by all: ${mine.length} word${mine.length === 1 ? "" : "s"} no one family leans on`;
  const more = mine.length > 8 ? ` +${mine.length - 8} more` : "";
  return `${familyLabel(f)} leans on ${mine.length} word${mine.length === 1 ? "" : "s"}: `
    + mine.slice(0, 8).join(", ") + more;
}

function wordDetail(w) {
  const models = `${w.models} model${w.models === 1 ? "" : "s"}`;
  const fams = w.families.map(([f, n]) => `${f} ${n}`).join(" · ");
  const lean = w.owner ? ` — ${w.owner} leans on it` : "";
  return `${w.word}: ${w.uses} uses by ${models} (${fams})${lean}`;
}

function renderCloud(cloud) {
  if (!cloud || !cloud.words.length) return "";
  // Sized by the damped weight when the export has one (see FAMILY_DAMPING in
  // omniroute-haiku.py), so a family with many models doesn't set every size.
  const sizeOf = w => w.weight ?? w.uses;
  const uses = cloud.words.map(sizeOf);
  const min = Math.min(...uses), max = Math.max(...uses);
  const words = [...cloud.words].sort((a, b) => wordHash(a.word) - wordHash(b.word) || (a.word < b.word ? -1 : 1));
  const spans = words.map(w => `<span class="cloud-word ${famAttrs(w.owner || "shared").cls}" tabindex="0"`
    + ` data-family="${esc(w.owner || "shared")}"`
    + ` style="font-size:${cloudSize(sizeOf(w), min, max).toFixed(2)}rem${famAttrs(w.owner || "shared").vars}"`
    + ` title="${esc(wordDetail(w))}" data-detail="${esc(wordDetail(w))}">${esc(w.word)}</span>`).join(" ");
  const keys = cloudLegend(cloud.words).map(([f, n]) => `<button type="button"`
    + ` class="cloud-key ${famAttrs(f).cls}"${famAttrs(f).vars ? ` style="${famAttrs(f).vars.slice(1)}"` : ""}`
    + ` data-family="${esc(f)}"`
    + ` aria-pressed="false"><i></i>${esc(familyLabel(f))} <span class="cloud-key-n">${n}</span></button>`).join("");
  const rows = cloud.words.map(w => `<tr><td>${esc(w.word)}</td><td class="num">${w.uses}</td>`
    + `<td class="num">${w.models}</td><td>${esc(w.owner || "—")}</td></tr>`).join("");
  return `
    <div class="month-group">
      <h2 class="month-heading">Word cloud</h2>
      <span class="month-count">${cloud.words.length} most-used words · ${cloud.haikus} haikus · last 14 days · size = uses, big families damped so none drowns out the rest · colour = the family that leans on it; tap a family to light up its words</span>
      <div class="cloud-legend">${keys}</div>
      <div class="bench-cloud">${spans}</div>
      <p class="cloud-detail" aria-live="polite">Hover or tap a word.</p>
      <details class="bench-dead">
        <summary>The words as a table</summary>
        <div class="bench-table-wrap">
          <table class="bench-table">
            <thead><tr><th>Word</th><th class="num">Uses</th><th class="num">Models</th><th>Leans</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>
    </div>`;
}

function renderLatest(data) {
  const run = data.latest_run;
  if (!run || !data.haikus.length) return "";
  const asked = run.ok + run.failed;
  const skipped = run.skipped ? ` · ${run.skipped} skipped after 3 errors in a row` : "";
  const probed = run.probed ? ` · ${run.probed} probed after 3 errors in a row` : "";
  const rows = data.haikus.map(h => `
    <div class="haiku-entry">
      ${h.lines.map(l => `<p>${esc(l)}</p>`).join("")}
      <div class="entry-meta">${badges(h)}</div>
    </div>`).join("");
  // Folded by default: the word cloud is the page, the run's haikus are detail.
  return `
    <details class="month-group bench-fold">
      <summary><span class="bench-fold-title">Latest run</span>
        <span class="month-count">${run.ok} of ${asked} answered · ${fmtUtc(run.started)}${skipped}${probed}</span></summary>
      <div class="month-entries">${rows}</div>
    </details>`;
}

function renderModels(data) {
  const answered = data.models.filter(m => m.ok > 0);
  const silent = data.models.filter(m => m.ok === 0);
  const rows = answered.map(m => `
    <tr>
      <td>${esc(benchName(m.model, m.provider))}</td>
      <td>${esc(m.provider)}</td>
      <td>${esc(m.effort || "default")}</td>
      <td class="num">${m.asked}×</td>
      <td class="num">${m.ok}</td>
      <td>${m.last_ok ? fmtUtc(m.last_ok) : "—"}</td>
    </tr>`).join("");
  const dead = silent.length ? `
    <details class="bench-dead">
      <summary>${silent.length} more listed model${silent.length === 1 ? "" : "s"} never answered</summary>
      <p>${silent.map(m => esc(m.model)).join(" · ")}</p>
    </details>` : "";
  // Folded like the latest run: the word cloud is the page.
  return `
    <details class="month-group bench-fold">
      <summary><span class="bench-fold-title">Models</span>
        <span class="month-count">${answered.length} answered · last ${data.window_days} days · ${data.runs_in_window} runs</span></summary>
      <div class="bench-table-wrap">
        <table class="bench-table">
          <thead><tr><th>Model</th><th>Provider</th><th title="reasoning level named by the model id; default = none requested">Effort</th><th class="num" title="times asked in the window">Used</th><th class="num">Answered</th><th>Last answer</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${dead}
    </details>`;
}


// ── Mood: the site's word list against a model ──
// site/main.js scores mood from a ~70-word warm/cool lexicon. scripts/mood-bench.py
// scored the same archive with TypeSafe's Jev, which reads the whole image. This
// section shows where they part. It is a comparison, not a correction: neither number
// has been checked against a reader, so the archive's mood still comes from the lexicon.
function fmtScore(v) {
  return (v > 0 ? "+" : v < 0 ? "\u2212" : "\u00b1") + Math.abs(v).toFixed(2);
}

function moodEntry(h) {
  const conf = h.conf === null ? "" : ` <span class="mood-conf">conf ${h.conf.toFixed(2)}</span>`;
  return `
    <div class="haiku-entry">
      ${h.lines.map(l => `<p>${esc(l)}</p>`).join("")}
      <div class="entry-meta mood-scores">
        <span class="source-badge">${esc(h.source || "untagged")}</span>
        <span class="mood-pair"><span class="mood-tag">word list</span> ${fmtScore(h.lex)}</span>
        <span class="mood-pair"><span class="mood-tag">model</span> ${fmtScore(h.jev)}</span>
        ${conf}
      </div>
    </div>`;
}

function renderMood(data) {
  if (!data || !data.n) return "";
  const s = data.summary;
  const cells = [
    `${data.n} haikus scored both ways`,
    `same warm/cool/even label ${s.agree_pct}%`,
    `correlation r ${s.r.toFixed(2)}`,
    `word list mean ${fmtScore(s.lex_mean)} \u00b7 model mean ${fmtScore(s.jev_mean)}`,
  ];
  if (s.flat_n) {
    cells.push(`of ${s.flat_n} haikus the word list scored exactly 0, the model calls `
      + `${s.flat_moved} warm or cool`);
  }
  return `
    <details class="month-group bench-fold">
      <summary><span class="bench-fold-title">Mood: a word list vs a model</span>
        <span class="month-count">${data.n} haikus \u00b7 agree on ${s.agree_pct}% \u00b7 r ${s.r.toFixed(2)}</span></summary>
      <div class="month-entries">
        <p class="bench-intro">
          The archive's mood score comes from a curated warm/cool word list, which counts
          words and cannot see how they combine. Here the same ${data.n} haikus are scored
          again by a model that reads the whole image, and the two are set side by side.
          Neither has been checked against a human reader, so this is a disagreement, not a
          verdict \u2014 the archive still uses the word list.
        </p>
        <div class="stats-strip">
          ${cells.map(c => `<span class="stat-cell">${c}</span>`).join("")}
        </div>
        <p class="stat-note">Scored ${esc(data.generated)} with ${esc(data.model)}.</p>
        <h3 class="mood-head">Where the model reads warmer</h3>
        <p class="stat-note">A thaw the word list counts as frost: it scores
          <em>silent</em> and <em>frost</em> and never reads <em>melts</em>.</p>
        ${data.jev_warmer.map(moodEntry).join("")}
        <h3 class="mood-head">Where the model reads cooler</h3>
        <p class="stat-note">Warm words, cold poem \u2014 the list has no way to hear a
          closing line take it back.</p>
        ${data.jev_cooler.map(moodEntry).join("")}
        <h3 class="mood-head">Where the model is least sure</h3>
        <p class="stat-note">The model reports its own confidence; these are the haikus it
          scored with the least of it.</p>
        ${data.unsure.map(moodEntry).join("")}
      </div>
    </details>`;
}

function renderBench(data) {
  const cloud = renderCloud(data.cloud);
  const latest = renderLatest(data);
  const models = data.models.length ? renderModels(data) : "";
  if (!cloud && !latest && !models) return `<p class="bench-empty">No bench runs published yet.</p>`;
  return cloud + latest + models;
}

if (typeof window !== "undefined") (async () => {
  const el = document.getElementById("bench-content");
  try {
    const res = await fetch("free-models.json");
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    el.innerHTML = renderBench(data);
    // Touch has no hover, so the word's breakdown also goes to a caption line.
    const detail = el.querySelector(".cloud-detail");
    const show = e => {
      const w = e.target.closest(".cloud-word");
      if (w && detail) detail.textContent = w.dataset.detail;
    };
    for (const ev of ["mouseover", "focusin", "click"]) el.addEventListener(ev, show);
    // Legend keys: hover or focus previews a family's words, a click or tap pins it.
    const legend = el.querySelector(".cloud-legend");
    if (legend) {
      const words = data.cloud.words;
      let pinned = null;
      const light = f => {
        for (const w of el.querySelectorAll(".cloud-word")) {
          w.classList.toggle("dim", f !== null && w.dataset.family !== f);
          w.classList.toggle("lit", f !== null && w.dataset.family === f);
        }
        if (detail) detail.textContent = f === null ? "Hover or tap a word." : familyDetail(words, f);
      };
      const keyOf = e => e.target.closest(".cloud-key");
      for (const ev of ["mouseover", "focusin"]) legend.addEventListener(ev, e => { if (keyOf(e)) light(keyOf(e).dataset.family); });
      for (const ev of ["mouseleave", "focusout"]) legend.addEventListener(ev, () => light(pinned));
      legend.addEventListener("click", e => {
        const k = keyOf(e);
        if (!k) return;
        pinned = pinned === k.dataset.family ? null : k.dataset.family;
        for (const b of legend.querySelectorAll(".cloud-key")) b.setAttribute("aria-pressed", String(b.dataset.family === pinned));
        light(pinned);
      });
    }
    const count = document.getElementById("bench-count");
    if (count) count.textContent = `${data.models.filter(m => m.ok > 0).length} models`;
  } catch {
    el.innerHTML = `<p class="bench-empty">No bench runs published yet.</p>`;
  }
})();

if (typeof window !== "undefined") (async () => {
  const el = document.getElementById("mood-content");
  if (!el) return;
  try {
    const res = await fetch("mood-bench.json");
    if (!res.ok) throw new Error(String(res.status));
    el.innerHTML = renderMood(await res.json());
  } catch {
    el.innerHTML = "";   // no comparison published: show nothing, not an error
  }
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { esc, benchName, fmtUtc, renderBench, renderMood, moodEntry, fmtScore, familyClass, cloudSize, wordDetail, renderCloud,
    cloudLegend, familyDetail };
}
