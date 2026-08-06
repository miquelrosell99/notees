# Documentation Health Maintenance

Keep the skills directory from degrading: files not too long, not too fragmented, no broken links, no duplicated content.

**Core principle: line counts are signals, not commands.** Exceeding a threshold triggers evaluation, not action. Only split when "over threshold + topics genuinely separable"; only merge when "fragmented + topics genuinely belong together".

## When to Run

- After completing the `update-rules.md` workflow, quickly check modified file line counts
- Proactive maintenance: when files feel "hard to navigate" or "too long to want to read"
- **Not required** after every small change

## Step 1: Size Scan

Check line counts for all files under `skills/notees/` and flag those that may need attention:

| File type | Reference range | Triggers evaluation | Fragment signal |
|---|---|---|---|
| `SKILL.md` | description ≤ 25 + body ≤ 90 lines (dual budget) | description > 25 (split intent clusters) or body > 90 (move detail) | — |
| `rules/*.md` | 50–200 lines | > 200 lines | < 30 lines |
| `workflows/*.md` | 30–150 lines | > 150 lines | < 15 lines |
| `references/*.md` | 50–300 lines | > 300 lines | < 30 lines |
| Thin shells | Routing + compatibility notes only | Rule/workflow bodies or project-specific process detail | — |

Note: these numbers are **reference values**, not hard thresholds. A 250-line rules file with a single coherent topic is perfectly fine to keep.

## Step 1b: Accumulation Check (tiered triggers — when to spend tokens)

Accumulation rot is not limited to gotchas, but the cost of detecting it is not uniform. A full agent-led reorganization of a 300-line file costs real tokens; the same file checked by `grep` costs nothing. The discipline below uses **three tiers** of trigger so the expensive scan only runs when the cheap one has already flagged something or when accumulated pressure has crossed a real threshold.

### The three tiers

| Tier | When it runs | Who runs it | Cost |
|---|---|---|---|
| **0 — bash gate** | Every `smoke-test.sh` run (every commit if wired into a hook) | `smoke-test.sh § 2a` — `grep "^## " <file> | sort | uniq -d` | ~0 tokens (bash) |
| **1 — AAR similarity scan** | Whenever the agent is about to append a new entry via `update-rules.md § Search Before Record` | The same agent that just ran the task — context is already loaded | ~few hundred tokens (targeted scan of 3–5 candidates, not the whole file) |
| **2 — full reorganization pass** | Only when a Tier-2 trigger fires (see below) | Agent reads the full file and restructures | ~thousands of tokens |

**Tier 2 triggers** — any one of these is enough; do not run Tier 2 just because it has been a while:

- File entry count > 25 for `references/gotchas.md` / `references/*pitfall*.md`
- File line count > 80% of cap (i.e. > 320 lines when cap is 400)
- `rules/*.md` has > 25 bullet-level rules
- `references/*.md` (non-gotchas) has > 40 entries
- Smoke-test Tier-0 flagged a duplicate **and** `.maintenance-log.yaml` shows the previous Tier-2 pass was > 30 days ago (a single dup is normal noise; recurring dups in a recently-cleaned file signal real drift). No ledger entry for the file = "no baseline yet" = treat the dup as a Tier-2 baseline trigger. See Step 7 for the ledger schema.
- A user explicitly asks for cleanup ("整理一下", "dedup gotchas", "reorganize this file")

Do **not** auto-fire Tier 2 from `smoke-test.sh`. Smoke-test should stay deterministic, fast, and free; Tier 2 lives in this workflow, run on demand.

### What Tier 2 does (the full pipeline)

Run these passes **in order** — they form a "categorize before splitting" pipeline so you do not split prematurely:

1. **Dedup scan (always first)** — surface real duplicates before any reorganization.
   - Exact-heading duplicates: `grep "^## " <file> | sort | uniq -d` lists every `##` heading that appears more than once. Same heading recorded twice = same entry copy-pasted; merge or delete one.
   - Topic-tag duplicates: `grep -oP '\*\*\[([^\]]+)\]' <file> | sort | uniq -c | sort -rn` lists `**[topic]**` tag frequency; tags with high counts are merge candidates.
   - Near-duplicates (different wording, same root cause) — agent reads the candidate set and decides; this is where Tier 2 spends most of its tokens, and why it is rare.
2. **Staleness scan** — are any entries about technology/patterns that have since been removed from the project? Delete stale entries or mark `<!-- DEPRECATED: reason, YYYY-MM -->`.
3. **Categorize (before splitting)** — if a file still has > 10 entries after dedup, group them under H2 categories before considering a split. This usually buys another 2–3× growth before a physical split is needed, and makes future dedup scans O(category) instead of O(file) — which lowers Tier-1 token cost too. **Categorization differs by file type:**

   - **Entries-style files** (`references/gotchas.md` / `references/*pitfall*.md`): promote frequent `**[topic]**` tags to `## CategoryName` headings; rename individual entries from `## **[topic]** title` to `### **[topic]** title` under the right category. The tag frequency grep `grep -oP '\*\*\[([^\]]+)\]' <file> | sort | uniq -c | sort -rn` tells you which tags deserve promotion.

   - **Rules files** (`rules/*.md`): rules don't carry `**[topic]**` tags, so categorize by **the natural axis the rules already divide on**. Pick exactly one axis per file — mixing axes makes the file harder to navigate, not easier; genuinely needing two axes is a split signal (Step 6), not a categorization signal. Three common axes:
     - **Module / surface boundary** — e.g. `web` vs `biz` vs `core` vs `dal` for a backend; `routes` vs `forms` vs `data-flow` for a frontend.
     - **Responsibility / lifecycle phase** — e.g. routing → validation → response wrapping → exception handling for an HTTP layer.
     - **Trigger scenario** — e.g. "when adding a new Controller" / "when changing an existing contract" / "when extending DAL".

     Re-anchor scattered bullets under the chosen H2. If a single H2 grows past ~30 bullet-rules, extract that section into its own sub-rule file via Step 6 instead of letting one category dominate.
4. **Structural scan** — after categorizing, re-anchor any remaining orphan entries under the correct H2 section.
5. **Tag audit** — do all entries carry `**[topic]**` tags? If > 50% are untagged, tag them in this same pass while attention is on the file.
6. **Split (last resort)** — only after dedup + categorize. Split when a single H2 category itself crosses the entry/line trigger, or when categories have genuinely different audiences (e.g. backend rules vs. frontend rules). Each resulting file should still be ≥ 30 lines after split (otherwise merge candidates).
7. **Update the maintenance ledger (closure gate)** — Tier-2 is incomplete until the ledger is updated. The ledger is the only mechanism that distinguishes "a duplicate in this file is normal noise" from "this file has drifted enough to need a full reorg"; without it, the > 30-days trigger in the list above has no clock and the whole tier model degrades to agent guesswork.

   - **Location:** `.maintenance-log.yaml` at skill root — `skills/<name>/.maintenance-log.yaml` downstream, `./.maintenance-log.yaml` self-hosting.
   - **Schema** (one entry per long-lived file the project intends to maintain at Tier-2; `path` required, `last_tier2` required once a pass has run, the rest advisory):
     ```yaml
     files:
       - path: references/gotchas.md
         last_tier2: 2026-04-15
         passes_run: [dedup, categorize]   # which steps 1–6 above actually executed
         entries_after: 18                  # grep -c '^## ' after the pass; baseline for next drift check
     ```
   - **Write step:** after completing steps 1–6 on a file, run `grep -c '^## ' <file>` for `entries_after`, list executed passes in `passes_run` (skipped passes that produced an empty diff still count as "run"; not-attempted passes are omitted), set `last_tier2: $(date +%Y-%m-%d)`, then write or replace the entry under `files:`.
   - **Read step:** `smoke-test.sh § 2a` consults the ledger on every detected duplicate `##` heading. No entry → "first-time dup, run Tier-2 baseline". `last_tier2` > 30 days → "Tier-2 stale, run full reorg". `last_tier2` ≤ 30 days → "dedup this entry only, skip full Tier-2". The duplicate itself always fails (verbatim copy-paste is always wrong); the ledger only governs whether *a full reorg* is recommended on top of the dedup.
   - **Stale ledger entries:** when this Tier-2 pass discovers a `path` that no longer exists in the project, remove the entry in the same pass. The ledger should never reference deleted files.

### Token-cost intuition for maintainers

- A project that adds ~5 new gotchas per month and is never reorganized will hit Tier 2 in about half a year. That is the expected cadence — not "weekly", not "yearly".
- Tier 1 runs at every closure event with a new gotcha. Most of those find no match and add the entry; a few find a near-match and merge. Both are cheap.
- Tier 0 runs at every commit. Free.

If you find yourself running Tier 2 more than once a quarter on the same file, the file is the wrong shape — split it (step 6 above) so each subfile stays under its own threshold.

A gotchas file that's too long to scan quickly defeats its purpose — the whole point is "brief, scannable list." The same applies to any file that agents read as part of task routing.

> **Note (2026-05-19):** an earlier draft of this workflow added a "Step 1c: External Fact Freshness" requiring authors to hand-mark each vendor/tool/runtime fact with `<!-- external-fact: verified=YYYY-MM-DD source=... -->` and run `check-external-facts.sh`. That section was removed along with the script — no project ever enforced the marker, so the script ran empty. If you need to flag a fact as volatile, prefer the AAR's "Outdated/obsolete rule" question (`update-rules.md`) on the next task that touches the same file: human re-read at the right moment beats a marker no one writes.

## Step 2: Evaluate — Should You Split?

When a file exceeds the reference range, answer these questions:

1. **Are the topics separable?** — Does the file contain 2+ independent topics where removing one doesn't affect understanding of the other?
2. **Is navigation difficult?** — Would someone looking for a specific section need to scroll through hundreds of lines to find it?
3. **Can each part stand alone?** — Would each resulting file have enough content (> 30 lines) to be independently useful?

**All three "yes" → splitting has value. Any "no" → don't split.**

### When NOT to Split

- File is long but highly coherent
- Splitting would create a sub-file too small (< 30 lines) to maintain independently
- Splitting would force readers to jump between two files to understand one concept
- File barely exceeds the reference value with no actual navigation difficulty

### Executing a Split

1. **Identify boundaries** — find independent topic blocks (usually H2 headings)
2. **Name new files** — rules: `*-rules.md`, workflows: verb-noun, references: noun-based
3. **Migrate content** — move to new files, keep heading levels reasonable
4. **Update routing** — edit `routing.yaml`, then run `scripts/sync-routing.sh`
5. **Update referrers** — other rule files that cross-reference the split files
6. **Verify** — no broken links, no duplicated content, nothing left behind

## Step 3: Evaluate — Should You Merge?

When fragment files are detected, answer these questions:

1. **Are the topics related?** — Do these small files belong to the same subject area?
2. **Is finding things easier after merging?** — Do readers frequently need to look at multiple files together?
3. **Will the merged file stay within limits?**

**All three "yes" → merging has value. Otherwise keep as-is.**

### Executing a Merge

1. **Merge** — combine content into one file, use H2 headings to separate original topics
2. **Check limits** — merged file should not exceed the type's reference limit
3. **Update references** — all locations that referenced the original files
4. **Clean up** — delete the original files

## Step 4: Reference Integrity Check

Run after any split, merge, rename, or deletion of files under `skills/notees/`:

- [ ] All links in SKILL.md's Always Read and generated Common Tasks are valid
- [ ] All `workflows/*.md` "Read First" sections reference existing files
- [ ] Cross-references between rules/references files point to valid targets
- [ ] Thin shells still point to the current `skills/notees/SKILL.md` or documented multi-skill router, and generated bootstraps match `routing.yaml`
- [ ] No orphaned files (file exists but no entry links to it)
- [ ] `route-health.sh` shows no new routing-quality smells (no/weak triggers, overlap, language) — advisory
- [ ] No duplicated content (each rule maintained in exactly one place)
- [ ] If a file was deleted, no other file still references it

## Completion Criteria

- Evaluated over-threshold files and made a **reasoned judgment** to keep or split
- If any file was split, merged, renamed, or deleted, reference integrity check passes
- `routing.yaml` and SKILL.md navigation match current file structure
