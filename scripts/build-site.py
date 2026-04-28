#!/usr/bin/env python3
"""Parse haiku.txt and write site/haiku.json (newest first). Also injects OG meta into index.html."""
import json
import os
import re

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAIKU_FILE = os.path.join(PROJECT_DIR, "haiku.txt")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "site", "haiku.json")
INDEX_FILE = os.path.join(PROJECT_DIR, "site", "index.html")

TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC(?:\s+\[(\w+)\])?")

haikus = []

with open(HAIKU_FILE) as f:
    lines = f.read().splitlines()

i = 0
while i < len(lines):
    m = TIMESTAMP_RE.match(lines[i].strip())
    if m:
        date, time, source = m.group(1), m.group(2), m.group(3)
        body, j = [], i + 1
        while j < len(lines) and len(body) < 3:
            l = lines[j].strip()
            if l:
                body.append(l)
            j += 1
        if len(body) == 3:
            haikus.append({
                "date": date,
                "timestamp": f"{date} {time} UTC",
                "source": source,
                "lines": body,
            })
        i = j
    else:
        i += 1

haikus.reverse()

with open(OUTPUT_FILE, "w") as f:
    json.dump(haikus, f, separators=(",", ":"))

print(f"Built {len(haikus)} haikus -> {OUTPUT_FILE}")

# Inject latest haiku into og:description in index.html
latest = haikus[0]
og_desc = " / ".join(latest["lines"])

with open(INDEX_FILE) as f:
    html = f.read()

html = re.sub(
    r'(<meta property="og:description" content=")[^"]*(")',
    f'\\g<1>{og_desc}\\g<2>',
    html,
)

with open(INDEX_FILE, "w") as f:
    f.write(html)

print(f"Injected OG description: {og_desc[:60]}...")
