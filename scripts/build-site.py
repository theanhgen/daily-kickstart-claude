#!/usr/bin/env python3
"""Parse haiku.txt and write site/haiku.json (newest first)."""
import json
import os
import re

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAIKU_FILE = os.path.join(PROJECT_DIR, "haiku.txt")
OUTPUT_FILE = os.path.join(PROJECT_DIR, "site", "haiku.json")

TIMESTAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC")

haikus = []

with open(HAIKU_FILE) as f:
    lines = f.read().splitlines()

i = 0
while i < len(lines):
    m = TIMESTAMP_RE.match(lines[i].strip())
    if m:
        date, time = m.group(1), m.group(2)
        body, j = [], i + 1
        while j < len(lines) and len(body) < 3:
            l = lines[j].strip()
            if l:
                body.append(l)
            j += 1
        if len(body) == 3:
            haikus.append({"date": date, "timestamp": f"{date} {time} UTC", "lines": body})
        i = j
    else:
        i += 1

haikus.reverse()

with open(OUTPUT_FILE, "w") as f:
    json.dump(haikus, f, separators=(",", ":"))

print(f"Built {len(haikus)} haikus -> {OUTPUT_FILE}")
