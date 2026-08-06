#!/usr/bin/env bash
# route-health.sh — Static routing-QUALITY lint (Tier 1 of the routing dashboard).
#
# Complements sync-routing.sh, does NOT duplicate it:
#   - sync-routing.sh --check already validates STRUCTURE: missing workflow/required
#     files, duplicate ids, missing `other`, missing labels. Those are hard errors.
#   - route-health.sh flags QUALITY SMELLS sync-routing does not: routes that can't
#     match well (no/weak triggers, ambiguous overlap, wrong-language triggers).
#
# Pure static read of routing.yaml. No usage data, no logging, no file written.
# Advisory: prints warnings and exits 0 (does not block). It is meant to run inside
# the closure path-integrity gate (when routing changed) and in profile/maintain/
# update-upstream sweeps — not every task, never on a timer.
#
# Does NOT catch time-drift (routes that silently stopped matching real work without
# any edit) — that needs usage data (a Tier 2 transcript miner), out of scope here.
#
# Usage: bash scripts/route-health.sh [skill-name|skill-root]
set -uo pipefail
TARGET="${1:-}"
if [[ -n "$TARGET" && -f "$TARGET/SKILL.md" ]]; then ROOT="$TARGET"
elif [[ -n "$TARGET" && -f "$TARGET/SKILL.md.template" ]]; then ROOT="$TARGET"
elif [[ -n "$TARGET" && -f "skills/$TARGET/SKILL.md" ]]; then ROOT="skills/$TARGET"
elif [[ -f "SKILL.md" && -f "routing.yaml" ]]; then ROOT="."
elif [[ -f "SKILL.md.template" && -f "routing.yaml" ]]; then ROOT="."
else echo "Usage: bash route-health.sh [skill-name|skill-root]" >&2; exit 2; fi

python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys, re

root = Path(sys.argv[1]).resolve()
manifest = root / "routing.yaml"
if not manifest.exists():
    raise SystemExit(f"no routing.yaml at {root}")

def clean(v):
    v = v.strip()
    if (v[:1] == '"' and v[-1:] == '"') or (v[:1] == "'" and v[-1:] == "'"):
        return v[1:-1]
    return v

def parse_inline_list(v):
    v = v.strip()
    if not (v.startswith("[") and v.endswith("]")):
        return []
    inner = v[1:-1].strip()
    if not inner:
        return []
    return [clean(part.strip()) for part in inner.split(",") if part.strip()]

# --- parse tasks: id + trigger_examples ---
tasks, cur, sec, top = [], None, None, None
for raw in manifest.read_text().splitlines():
    s = raw.strip()
    if not s or s.startswith("#"):
        continue
    if s == "always_read:": top, cur, sec = "ar", None, None; continue
    if s == "tasks:": top, sec = "t", None; continue
    if raw.startswith("  - id:"):
        cur = {"id": clean(raw.split(":", 1)[1]), "triggers": []}
        tasks.append(cur); sec = None; continue
    if cur is None:
        continue
    if raw.startswith("    trigger_examples:"):
        sec = "te"
        _, value = s.split(":", 1)
        cur["triggers"].extend(parse_inline_list(value))
        if value.strip().startswith("["):
            sec = None
        continue
    if raw.startswith("    required_reads:") or raw.startswith("    labels:"): sec = None; continue
    if sec == "te" and raw.startswith("      - "): cur["triggers"].append(clean(s[2:])); continue
    if raw.startswith("    ") and ":" in s: sec = None

def real_triggers(t):
    return [x for x in t["triggers"] if x and "FILL" not in x and "<!--" not in x]

def has_cjk(s):
    return any("一" <= c <= "鿿" for c in s)

LATIN_STOP = {"the", "this", "that", "for", "and", "you", "with", "new", "fix", "add", "let",
              "use", "run", "this", "your", "what", "how", "can", "all"}
CJK_STOP = {"这个", "一个", "帮我", "一下", "我的", "怎么", "什么", "这里", "这次", "这条"}

def tokens(t):
    toks = set()
    for ex in real_triggers(t):
        for w in re.findall(r"[a-z0-9]{3,}", ex.lower()):
            if w not in LATIN_STOP:
                toks.add(w)
        for run in re.findall(r"[一-鿿]{2,}", ex):
            if run not in CJK_STOP:
                toks.add(run)
    return toks

warns = []
non_other = [t for t in tasks if t["id"] != "other"]

# 1) no / weak triggers
for t in non_other:
    rt = real_triggers(t)
    if len(rt) == 0:
        warns.append(("no-triggers", f"{t['id']}: no real trigger_examples (only FILL/empty) — route can't be matched"))
    elif len(rt) == 1:
        warns.append(("weak-triggers", f"{t['id']}: only 1 trigger_example (>=2 recommended)"))

# 2) language mismatch (vs the corpus's dominant script)
cjk_routes = sum(1 for t in non_other if any(has_cjk(x) for x in real_triggers(t)))
latin_routes = sum(1 for t in non_other if any(not has_cjk(x) for x in real_triggers(t)))
if cjk_routes and latin_routes:
    dominant_cjk = cjk_routes >= latin_routes
    for t in non_other:
        rt = real_triggers(t)
        if not rt:
            continue
        all_cjk = all(has_cjk(x) for x in rt)
        all_latin = all(not has_cjk(x) for x in rt)
        if dominant_cjk and all_latin:
            warns.append(("language", f"{t['id']}: triggers are English-only but most routes use CJK — may miss the user's actual language"))
        elif (not dominant_cjk) and all_cjk:
            warns.append(("language", f"{t['id']}: triggers are CJK-only but most routes use English"))

# 3) trigger overlap (>=2 shared *discriminating* tokens => mis-route risk).
#    Only tokens unique to a pair (document-frequency == 2) count; ubiquitous
#    project/domain words (project name, core domain terms) have high df and are
#    not discriminating, so they are ignored to avoid noise.
tok = {t["id"]: tokens(t) for t in non_other}
df = {}
for toks in tok.values():
    for w in toks:
        df[w] = df.get(w, 0) + 1
ids = [t["id"] for t in non_other]
for i in range(len(ids)):
    for j in range(i + 1, len(ids)):
        shared = {w for w in (tok[ids[i]] & tok[ids[j]]) if df.get(w, 0) == 2}
        if len(shared) >= 2:
            warns.append(("overlap", f"{ids[i]} ~ {ids[j]}: share {sorted(shared)} — mis-route risk"))

print(f"Route health — {root.name}  (static routing-quality lint; advisory, no logging)")
print("-" * 66)
if not warns:
    print(f"  OK: {len(non_other)} routes, no quality smells.")
else:
    order = {"no-triggers": 0, "weak-triggers": 1, "language": 2, "overlap": 3}
    for _, msg in sorted(warns, key=lambda w: order.get(w[0], 9)):
        print(f"  ! {msg}")
    print()
    print(f"=> {len(warns)} warning(s) across {len(non_other)} routes. Advisory — fix the")
    print("   high-value ones (no/weak triggers). sync-routing.sh --check covers hard breakage.")
PY
