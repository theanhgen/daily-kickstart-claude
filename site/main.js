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
          <span class="source-badge">claude</span>
        </div>
        <div class="pair-col">
          <div class="haiku loaded">${haikuLines(first.codex)}</div>
          <span class="source-badge">codex</span>
        </div>
      </div>
      <div class="haiku-date">${formatDate(first.claude.date)}</div>`;
  } else {
    const h = first.haiku;
    container.innerHTML = `
      <div class="haiku loaded">${haikuLines(h)}</div>
      <div class="haiku-meta">
        <span class="haiku-date">${formatDate(h.date)}</span>
        ${h.source ? `<span class="source-badge">${h.source}</span>` : ""}
      </div>`;
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
    .map(([date, entries]) => {
      const items = pairUp(entries);
      const rows = items.map(item => {
        if (item.type === "pair") {
          return `
            <div class="haiku-entry haiku-entry-pair">
              <div class="pair-col">
                ${haikuLines(item.claude)}
                <div class="entry-meta">
                  <span class="time">${item.claude.timestamp.slice(11, 16)} UTC</span>
                  <span class="source-badge">claude</span>
                </div>
              </div>
              <div class="pair-col">
                ${haikuLines(item.codex)}
                <div class="entry-meta">
                  <span class="time">${item.codex.timestamp.slice(11, 16)} UTC</span>
                  <span class="source-badge">codex</span>
                </div>
              </div>
            </div>`;
        }
        const h = item.haiku;
        return `
          <div class="haiku-entry">
            ${haikuLines(h)}
            <div class="entry-meta">
              <span class="time">${h.timestamp.slice(11, 16)} UTC</span>
              ${h.source ? `<span class="source-badge">${h.source}</span>` : ""}
            </div>
          </div>`;
      }).join("");
      return `<div class="date-group"><div class="date-label">${formatDate(date)}</div>${rows}</div>`;
    }).join("");
}

(async () => {
  try {
    const haikus = await loadHaikus();
    if (document.getElementById("main-content")) renderMain(haikus);
    if (document.getElementById("archive-content")) renderArchive(haikus);
  } catch {
    const el = document.getElementById("main-content") || document.getElementById("archive-content");
    if (el) el.innerHTML = "<p>—</p>";
  }
})();
