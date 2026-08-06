#!/usr/bin/env bash
# audit-orphans.sh — Surface content-tier + workflow files with zero inbound links.
#
# Audited dirs = rules/ references/ architecture/ gotchas/ conventions/ workflows/.
# An orphan is a file in one of those whose relative path does not appear
# (outside fenced code blocks) in any workflow / tier file / routing.yaml /
# top-level shell. Either the activation pointer was never added, or the
# routing that used to mention it was removed and the file lingered.
#
# Heuristic only: prose mentions of the concept without the path do not count.
# routing.yaml IS scanned, so a file referenced only from a task's
# required_reads counts as reachable (it is on a route). Whether that route
# can actually match (trigger quality) is route-health.sh's job, not this one's.
#
# Usage (run from the skill root, the dir holding the tier directories):
#   bash audit-orphans.sh
#
# Exit code: 0 = no orphans, 1 = one or more orphans found.

set -euo pipefail

ROOT="$PWD"

# Content tiers: audited for orphan status AND scanned as inbound-link sources.
# Each is existence-guarded below, so a skill that uses only some tiers is fine.
TIER_DIRS=(rules references architecture gotchas conventions)

# Workflows are ALSO audited for orphan status: a workflow reachable from no
# route (routing.yaml workflow:/required_reads), no other workflow, no rule,
# SKILL.md, or shell is dead weight — routed OR cross-referenced = reachable.
# (.example files are skipped by the *.md glob; README.md/index.md are skipped.)
AUDIT_DIRS=("${TIER_DIRS[@]}" workflows)

SCAN_DIRS=("$ROOT/workflows")
for t in "${TIER_DIRS[@]}"; do SCAN_DIRS+=("$ROOT/$t"); done

SCAN_FILES=()
for f in "$ROOT"/*.md; do
  [[ -f "$f" ]] && SCAN_FILES+=("$f")
done
# routing.yaml: a file in a task's required_reads is on a route → reachable.
[[ -f "$ROOT/routing.yaml" ]] && SCAN_FILES+=("$ROOT/routing.yaml")
# Nested under skills/<name>/? Also scan the parent harness shells.
if [[ -f "$ROOT/../../AGENTS.md" || -f "$ROOT/../../CLAUDE.md" ]]; then
  for s in AGENTS.md CLAUDE.md CODEX.md GEMINI.md; do
    [[ -f "$ROOT/../../$s" ]] && SCAN_FILES+=("$ROOT/../../$s")
  done
fi

strip_fences() { awk 'BEGIN{f=0} /^```/ {f=1-f; next} !f' "$1"; }

mentions() {
  [[ -f "$2" ]] || return 1
  strip_fences "$2" | grep -qF "$1"
}

# $2 = the string to search for. Tiers pass the full rel path (precise); workflows
# pass the bare basename, because sibling workflows cross-link same-dir style
# ([x](task-closure.md)) AND routing/full-path refs (skill:workflows/task-closure.md)
# both contain the basename — so basename catches both, full-path would miss the former.
count_inbound() {
  local rel="$1" abs="$ROOT/$1" match="${2:-$1}" count=0 dir f
  for dir in "${SCAN_DIRS[@]}"; do
    [[ -d "$dir" ]] || continue
    for f in "$dir"/*.md; do
      [[ -f "$f" && "$f" != "$abs" ]] || continue
      mentions "$match" "$f" 2>/dev/null && count=$((count+1))
    done
  done
  for f in "${SCAN_FILES[@]:-}"; do
    [[ -n "$f" && -f "$f" && "$f" != "$abs" ]] || continue
    mentions "$match" "$f" 2>/dev/null && count=$((count+1))
  done
  echo "$count"
}

ORPHANS=0
TOTAL=0
echo "Orphan scan — content-tier + workflow files with zero inbound links"
echo "==================================================================="
for dir_name in "${AUDIT_DIRS[@]}"; do
  dir_abs="$ROOT/$dir_name"
  [[ -d "$dir_abs" ]] || continue
  for f in "$dir_abs"/*.md; do
    [[ -f "$f" ]] || continue
    case "$(basename "$f")" in README.md|index.md) continue ;; esac
    TOTAL=$((TOTAL+1))
    rel="${f#$ROOT/}"
    # workflows cross-link by bare same-dir filename; tiers use the full rel path
    if [[ "$dir_name" == workflows ]]; then match="$(basename "$f")"; else match="$rel"; fi
    if [[ "$(count_inbound "$rel" "$match")" -eq 0 ]]; then
      echo "ORPHAN  $rel"
      ORPHANS=$((ORPHANS+1))
    fi
  done
done

echo ""
echo "Summary: $ORPHANS orphan(s) / $TOTAL file(s)"
if [[ "$ORPHANS" -gt 0 ]]; then
  echo "For each orphan: add an activation pointer (workflow / routing.yaml / SKILL.md route) or delete it."
  exit 1
fi
exit 0
