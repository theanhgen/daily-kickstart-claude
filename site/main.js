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

function sourceTag(source) {
  if (!source) return "";
  return `<span class="source-badge">${source}</span>`;
}

function renderMain(haikus) {
  const latest = haikus[0];
  const el = document.getElementById("haiku");
  el.innerHTML = latest.lines.map(l => `<p>${l}</p>`).join("");
  el.classList.add("loaded");
  document.getElementById("haiku-date").textContent = formatDate(latest.date);
  const src = document.getElementById("haiku-source");
  if (latest.source) {
    src.textContent = latest.source;
    src.style.display = "";
  } else {
    src.style.display = "none";
  }
}

function renderArchive(haikus) {
  const count = document.getElementById("haiku-count");
  if (count) count.textContent = `${haikus.length} haikus`;

  const byDate = {};
  for (const h of haikus) {
    (byDate[h.date] ??= []).push(h);
  }

  document.getElementById("archive-content").innerHTML = Object.entries(byDate)
    .map(([date, entries]) => `
      <div class="date-group">
        <div class="date-label">${formatDate(date)}</div>
        ${entries.map(h => `
          <div class="haiku-entry">
            ${h.lines.map(l => `<p>${l}</p>`).join("")}
            <div class="entry-meta">
              <span class="time">${h.timestamp.slice(11, 16)} UTC</span>
              ${h.source ? `<span class="source-badge">${h.source}</span>` : ""}
            </div>
          </div>`).join("")}
      </div>`).join("");
}

(async () => {
  try {
    const haikus = await loadHaikus();
    if (document.getElementById("haiku")) renderMain(haikus);
    if (document.getElementById("archive-content")) renderArchive(haikus);
  } catch {
    const el = document.getElementById("haiku") || document.getElementById("archive-content");
    if (el) el.innerHTML = "<p>—</p>";
  }
})();
