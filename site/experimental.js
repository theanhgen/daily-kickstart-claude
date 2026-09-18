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
  return `
    <div class="month-group">
      <h2 class="month-heading">Latest run</h2>
      <span class="month-count">${run.ok} of ${asked} answered · ${fmtUtc(run.started)}${skipped}</span>
      <div class="month-entries">${rows}</div>
    </div>`;
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
  return `
    <div class="month-group">
      <h2 class="month-heading">Models</h2>
      <span class="month-count">last ${data.window_days} days · ${data.runs_in_window} runs · answered/asked</span>
      <div class="bench-table-wrap">
        <table class="bench-table">
          <thead><tr><th>Model</th><th>Provider</th><th>Effort</th><th class="num">Answered</th><th>Last answer</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${dead}
    </div>`;
}

function renderBench(data) {
  const latest = renderLatest(data);
  const models = data.models.length ? renderModels(data) : "";
  if (!latest && !models) return `<p class="bench-empty">No bench runs published yet.</p>`;
  return latest + models;
}

if (typeof window !== "undefined") (async () => {
  const el = document.getElementById("bench-content");
  try {
    const res = await fetch("free-models.json");
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    el.innerHTML = renderBench(data);
    const count = document.getElementById("bench-count");
    if (count) count.textContent = `${data.models.filter(m => m.ok > 0).length} models`;
  } catch {
    el.innerHTML = `<p class="bench-empty">No bench runs published yet.</p>`;
  }
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { esc, benchName, fmtUtc, renderBench };
}
