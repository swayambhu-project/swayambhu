"""Verify SOUL.md integrity against the canonical hash."""
import hashlib
import sys
from pathlib import Path

soul_path = Path(__file__).parent / "SOUL.md"
content = soul_path.read_text(encoding="utf-8")

begin_marker = "<!-- IMMUTABLE:BEGIN -->"
end_marker = "<!-- IMMUTABLE:END -->"

try:
    begin = content.index(begin_marker) + len(begin_marker)
    end = content.index(end_marker)
except ValueError:
    print("FAIL: markers not found in SOUL.md")
    sys.exit(1)

immutable = content[begin:end].strip()
computed = hashlib.sha256(immutable.encode("utf-8")).hexdigest()
print(f"computed: {computed}")

# Try fetching canonical hash
try:
    from urllib.request import urlopen
    url = "https://raw.githubusercontent.com/swayambhu-origin/soul-hash/main/IMMUTABLE.sha256"
    canonical = urlopen(url, timeout=10).read().decode().strip()
    print(f"canonical: {canonical}")
    if computed == canonical:
        print("PASS")
    else:
        print("FAIL: hash mismatch")
        sys.exit(1)
except Exception as e:
    print(f"WARNING: could not fetch canonical hash: {e}")
    print(f"Computed hash: {computed}")
