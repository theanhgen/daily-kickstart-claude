#!/usr/bin/env python3
"""Parse haiku.txt and write site/haiku.json (newest first).

Also generates, for every haiku, a shareable permalink page at
site/h/<slug>/index.html with its own Open Graph / Twitter tags and a
1200x630 preview image (og.png), and injects the latest haiku's OG meta
into index.html. Permalink pages + images are build artifacts (never
committed); in CI an Actions cache restores prior og.png files so only
new haikus are rendered each deploy.
"""
import html
import json
import os
import re
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAIKU_FILE = os.path.join(PROJECT_DIR, "haiku.txt")
SITE_DIR = os.path.join(PROJECT_DIR, "site")
OUTPUT_FILE = os.path.join(SITE_DIR, "haiku.json")
INDEX_FILE = os.path.join(SITE_DIR, "index.html")
SHARE_DIR = os.path.join(SITE_DIR, "h")

# Canonical origin for absolute OG urls (project Pages live under a base path).
SITE_URL = os.environ.get("SITE_URL", "https://theanhgen.github.io/daily-kickstart-claude").rstrip("/")

ACCENT = {"claude": (200, 98, 43), "codex": (42, 125, 98), "agy": (79, 91, 213)}

TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC(?:\s+\[(\w+)\])?")


def parse_haikus():
    with open(HAIKU_FILE) as f:
        lines = f.read().splitlines()
    out, i = [], 0
    while i < len(lines):
        m = TIMESTAMP_RE.match(lines[i].strip())
        if not m:
            i += 1
            continue
        date, time, source = m.group(1), m.group(2), m.group(3)
        # Pre-2026-04-07 haikus predate engine tagging (claude only); attribute
        # them so analysis, badges, and permalinks cover the full archive.
        if source is None and date <= "2026-04-07":
            source = "claude"
        body, j = [], i + 1
        while j < len(lines) and len(body) < 3:
            l = lines[j].strip()
            if l:
                body.append(l)
            j += 1
        if len(body) == 3:
            out.append({"date": date, "timestamp": f"{date} {time} UTC",
                        "source": source, "lines": body})
        i = j
    out.reverse()
    return out


def slug(h):
    """Stable, URL-safe id: YYYYMMDD-HHMMSS-engine. Mirrored in main.js."""
    stamp = h["timestamp"][:19].replace("-", "").replace(":", "").replace(" ", "-")
    return f"{stamp}-{h['source'] or 'claude'}"


def pretty_date(date_str):
    return datetime.strptime(date_str, "%Y-%m-%d").strftime("%B %-d, %Y")


# ── Preview image (Pillow optional: skip cleanly when unavailable) ──

def _font_path(candidates):
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def load_fonts():
    try:
        from PIL import ImageFont  # noqa: F401
    except Exception:
        return None
    bundled = os.path.join(SITE_DIR, "assets", "fonts")
    italic = _font_path([
        os.path.join(bundled, "DMSerifDisplay-Italic.ttf"),
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    ])
    regular = _font_path([
        os.path.join(bundled, "DMSerifDisplay-Regular.ttf"),
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    ])
    if not italic or not regular:
        return None
    return {"italic": italic, "regular": regular}


def render_card(h, path, fonts):
    from PIL import Image, ImageDraw, ImageFont
    W, Hh = 1200, 630
    bg, fg, muted = (250, 249, 247), (26, 26, 26), (150, 150, 150)
    accent = ACCENT.get(h["source"] or "claude", muted)
    img = Image.new("RGB", (W, Hh), bg)
    d = ImageDraw.Draw(img)

    # Auto-fit the haiku so the widest line never overflows the safe width.
    maxw, size = W - 220, 76
    while size > 28:
        f = ImageFont.truetype(fonts["italic"], size)
        widest = max(d.textlength(l, font=f) for l in h["lines"])
        if widest <= maxw and size * 1.55 * 3 <= Hh - 240:
            break
        size -= 2
    f = ImageFont.truetype(fonts["italic"], size)
    lh = size * 1.55
    total = lh * 3
    top = (Hh - total) / 2 + 18

    # Accent rule centered above the haiku.
    d.rectangle([W / 2 - 34, top - 40, W / 2 + 34, top - 37], fill=accent)

    y = top
    for l in h["lines"]:
        w = d.textlength(l, font=f)
        d.text(((W - w) / 2, y), l, font=f, fill=fg)
        y += lh

    # Wordmark (top-left) and attribution (bottom-center).
    fm = ImageFont.truetype(fonts["regular"], 24)
    d.text((80, 64), "DAILY HAIKU", font=fm, fill=muted)
    label = f"{h['source'] or 'claude'}   ·   {pretty_date(h['date'])}"
    fl = ImageFont.truetype(fonts["regular"], 26)
    lw = d.textlength(label, font=fl)
    d.text(((W - lw) / 2, Hh - 96), label, font=fl, fill=accent)

    img.save(path, "PNG")


# ── Permalink page ──

PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="icon" href="{site}/favicon.svg" type="image/svg+xml">
<link rel="icon" href="{site}/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="{site}/apple-touch-icon.png">
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Daily Haiku">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{img}">
<link rel="stylesheet" href="{site}/style.css">
<style>.haiku p{{white-space:normal}}</style>
</head>
<body>
<main class="main-layout">
<span class="haiku-kicker">{date}</span>
<div class="haiku loaded">{lines}</div>
<div class="haiku-rule" style="background:var(--{src}-text)"></div>
<div class="haiku-meta"><span class="source-badge source-{src}">{src}</span></div>
<a class="nav-link" href="{site}/">&#8592; Today's haiku</a>
</main>
</body>
</html>
"""


def write_permalink(h, fonts):
    s = slug(h)
    src = h["source"] or "claude"
    out_dir = os.path.join(SHARE_DIR, s)
    os.makedirs(out_dir, exist_ok=True)
    url = f"{SITE_URL}/h/{s}/"
    img = f"{url}og.png"
    desc = html.escape(" / ".join(h["lines"]), quote=True)
    lines_html = "".join(f"<p>{html.escape(l, quote=True)}</p>" for l in h["lines"])
    page = PAGE.format(
        title=html.escape(f"A haiku by {src}", quote=True),
        desc=desc, url=url, img=img, site=SITE_URL,
        date=html.escape(pretty_date(h["date"]), quote=True),
        lines=lines_html, src=src,
    )
    with open(os.path.join(out_dir, "index.html"), "w") as f:
        f.write(page)

    png = os.path.join(out_dir, "og.png")
    if fonts and not os.path.exists(png):   # cache: skip already-rendered images
        render_card(h, png, fonts)
    return os.path.exists(png)


# ── Main ──

haikus = parse_haikus()

with open(OUTPUT_FILE, "w") as f:
    json.dump(haikus, f, separators=(",", ":"))
print(f"Built {len(haikus)} haikus -> {OUTPUT_FILE}")

fonts = load_fonts()
if not fonts:
    print("WARNING: Pillow/serif font unavailable — skipping preview images (pages still emitted)")

rendered = 0
for h in haikus:
    if write_permalink(h, fonts):
        rendered += 1
print(f"Wrote {len(haikus)} permalink pages -> {SHARE_DIR} ({rendered} with images)")

# Inject latest haiku's OG meta into index.html.
latest = haikus[0]
og_desc = html.escape(" / ".join(latest["lines"]), quote=True)
og_img = f"{SITE_URL}/h/{slug(latest)}/og.png"
with open(INDEX_FILE) as f:
    page = f.read()
page = re.sub(r'(<meta property="og:description" content=")[^"]*(")',
              lambda m: m.group(1) + og_desc + m.group(2), page)
page = re.sub(r'(<meta property="og:image" content=")[^"]*(")',
              lambda m: m.group(1) + og_img + m.group(2), page)
with open(INDEX_FILE, "w") as f:
    f.write(page)
print(f"Injected OG: {og_desc[:50]}... image={og_img}")
