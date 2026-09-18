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
// Colour slots 1-3 go to these families BY NAME, never by rank, so a word keeps
// its colour when the families reshuffle. Three is the most a cloud can carry:
// every colour sits next to every other, and past three the categorical palette
// stops separating for colour-blind readers. Any other family's words are grey.
const CLOUD_FAMILIES = ["gemini", "mistral", "qwen"];
const CLOUD_MIN_REM = 0.85;
const CLOUD_MAX_REM = 2.6;

function familyClass(owner) {
  if (!owner) return "shared";
  return CLOUD_FAMILIES.includes(owner) ? owner : "other";
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

function wordDetail(w) {
  const models = `${w.models} model${w.models === 1 ? "" : "s"}`;
  const fams = w.families.map(([f, n]) => `${f} ${n}`).join(" · ");
  const lean = w.owner ? ` — ${w.owner} leans on it` : "";
  return `${w.word}: ${w.uses} uses by ${models} (${fams})${lean}`;
}

function renderCloud(cloud) {
  if (!cloud || !cloud.words.length) return "";
  const uses = cloud.words.map(w => w.uses);
  const min = Math.min(...uses), max = Math.max(...uses);
  const words = [...cloud.words].sort((a, b) => wordHash(a.word) - wordHash(b.word) || (a.word < b.word ? -1 : 1));
  const spans = words.map(w => `<span class="cloud-word fam-${familyClass(w.owner)}" tabindex="0"`
    + ` style="font-size:${cloudSize(w.uses, min, max).toFixed(2)}rem"`
    + ` title="${esc(wordDetail(w))}" data-detail="${esc(wordDetail(w))}">${esc(w.word)}</span>`).join(" ");
  const keys = [...CLOUD_FAMILIES, "other", "shared"].map(f => `<span class="cloud-key fam-${f}"><i></i>`
    + `${f === "other" ? "other family" : f === "shared" ? "shared by all" : f}</span>`).join("");
  const rows = cloud.words.map(w => `<tr><td>${esc(w.word)}</td><td class="num">${w.uses}</td>`
    + `<td class="num">${w.models}</td><td>${esc(w.owner || "—")}</td></tr>`).join("");
  return `
    <div class="month-group">
      <h2 class="month-heading">Word cloud</h2>
      <span class="month-count">${cloud.words.length} most-used words · ${cloud.haikus} haikus · last 14 days · size = uses, colour = the family that leans on it</span>
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
  const rows = data.haikus.map(h => `
    <div class="haiku-entry">
      ${h.lines.map(l => `<p>${esc(l)}</p>`).join("")}
      <div class="entry-meta">${badges(h)}</div>
    </div>`).join("");
  // Folded by default: the word cloud is the page, the run's haikus are detail.
  return `
    <details class="month-group bench-fold">
      <summary><span class="bench-fold-title">Latest run</span>
        <span class="month-count">${run.ok} of ${asked} answered · ${fmtUtc(run.started)}${skipped}</span></summary>
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
      <td class="num">${m.ok}/${m.asked}</td>
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
          <thead><tr><th>Model</th><th>Provider</th><th>Effort</th><th class="num">Answered</th><th>Last answer</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${dead}
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
    const count = document.getElementById("bench-count");
    if (count) count.textContent = `${data.models.filter(m => m.ok > 0).length} models`;
  } catch {
    el.innerHTML = `<p class="bench-empty">No bench runs published yet.</p>`;
  }
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { esc, benchName, fmtUtc, renderBench, familyClass, cloudSize, wordDetail, renderCloud };
}
