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
// Picked as the three that lean on the most words (Sep 2026: gemini 18, llama 8,
// mistral 6, qwen 0); revisit by hand if that changes, never automatically.
const CLOUD_FAMILIES = ["gemini", "mistral", "llama"];
const CLOUD_MIN_REM = 0.85;
const CLOUD_MAX_REM = 3.2;

function familyClass(owner) {
  if (!owner) return "shared";
  return CLOUD_FAMILIES.includes(owner) ? owner : "other";
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

// ── Packed layout ──
// The Wordle layout: biggest word first, each one placed at the first clear spot
// on a spiral out from the centre, so the heavy words gather in the middle. Pure
// over measured boxes so node can test it; layoutCloud measures the spans, packs
// them and positions them absolutely.
const PACK_GAP = 3;        // px of clear space between two words
const PACK_PITCH = 1.4;    // px the spiral's radius grows per radian, ~9px a turn
const PACK_STEP = 4;       // px along the spiral between tries
const PACK_TRIES = 30000;

// boxes: [{w, h}] in placement order. Returns [{x0, x1, y0, y1}] around a (0, 0)
// centre, every box inside [-width/2, width/2].
function packCloud(boxes, width) {
  const half = width / 2;
  // Wide screens pack an oval, phones a round cloud that grows downward.
  const stretch = Math.min(2, Math.max(1, width / 360));
  const placed = [];
  const clear = r => placed.every(p => r.x1 + PACK_GAP <= p.x0 || p.x1 + PACK_GAP <= r.x0
    || r.y1 + PACK_GAP <= p.y0 || p.y1 + PACK_GAP <= r.y0);
  for (const { w, h } of boxes) {
    const room = Math.max(0, half - w / 2);
    let rect = null;
    for (let i = 0, t = 0; i < PACK_TRIES && !rect; i++) {
      const r = PACK_PITCH * t;
      const x = r * Math.cos(t) * stretch, y = r * Math.sin(t);
      if (Math.abs(x) <= room) {
        const c = { x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 };
        if (clear(c)) rect = c;
      }
      t += PACK_STEP / Math.max(r, PACK_STEP);
    }
    // Wider than the screen, or no room found: a row of its own under the rest.
    if (!rect) {
      const bottom = placed.length ? Math.max(...placed.map(p => p.y1)) + PACK_GAP : 0;
      rect = { x0: -w / 2, x1: w / 2, y0: bottom, y1: bottom + h };
    }
    placed.push(rect);
  }
  return placed;
}

function layoutCloud(box) {
  const width = box.clientWidth;
  if (!width) return;
  box.classList.add("packed");
  const spans = [...box.querySelectorAll(".cloud-word")];
  const rects = packCloud(spans.map(s => {
    const b = s.getBoundingClientRect();
    return { w: b.width, h: b.height };
  }), width);
  const top = Math.min(...rects.map(r => r.y0));
  spans.forEach((s, i) => {
    s.style.left = `${(width / 2 + rects[i].x0).toFixed(1)}px`;
    s.style.top = `${(rects[i].y0 - top).toFixed(1)}px`;
  });
  box.style.height = `${Math.ceil(Math.max(...rects.map(r => r.y1)) - top)}px`;
  box.dataset.width = String(width);
}

function renderCloud(cloud) {
  if (!cloud || !cloud.words.length) return "";
  const uses = cloud.words.map(w => w.uses);
  const min = Math.min(...uses), max = Math.max(...uses);
  // Most-used first: the order they are packed in, and the reading order.
  const words = [...cloud.words].sort((a, b) => b.uses - a.uses || (a.word < b.word ? -1 : 1));
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
    // Pack once the font is in (its widths decide the layout), and again whenever the
    // column changes width. Until then the words sit in a plain wrapped row.
    const box = el.querySelector(".bench-cloud");
    if (box) {
      const pack = () => layoutCloud(box);
      pack();
      if (document.fonts) {
        document.fonts.ready.then(pack);
        document.fonts.addEventListener("loadingdone", pack);
      }
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => {
          if (box.clientWidth && String(box.clientWidth) !== box.dataset.width) pack();
        }).observe(box);
      }
    }
    const count = document.getElementById("bench-count");
    if (count) count.textContent = `${data.models.filter(m => m.ok > 0).length} models`;
  } catch {
    el.innerHTML = `<p class="bench-empty">No bench runs published yet.</p>`;
  }
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { esc, benchName, fmtUtc, renderBench, familyClass, cloudSize, wordDetail, renderCloud, packCloud };
}
