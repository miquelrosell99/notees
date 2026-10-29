# Citekey-centric display + search — design spec

**Date:** 2026-10-29
**Status:** proposed (pre-implementation)
**Companion:** `.plans/2026-10-23-1801-source-library-zotero-flow/` — the 39-class
Zotero-faithful roster extending `source` is the landscape this spec renders
against. This spec adds NO classes or properties; it adds one class field and
two search seams.

## Goal

Make Notees citekey-centric in the Zotero sense, in two moves:

1. **Find sources fast.** A bare term in global/quick search finds a source by
   its citekey, its authors, or any other property value — no query syntax
   required. `citekey:`/`author:` become first-class DSL fields.
2. **Read sources as their citekeys.** A class-level display template lets
   sources render as `@doe2024` everywhere a node is *referenced* (mentions,
   links, pickers, backlinks, breadcrumbs, search results, graph) while
   title-is-content stays the authority — the template is a render layer,
   never identity.

Success: a user types `doe2024` (or `@doe2024` in a mention) and lands on the
source; every reference to the source reads as `@doe2024`; a source with no
citekey still reads as its title; classes that shouldn't render as citekeys
(video, book, the AV family) don't.

## Non-goals

- **Citekey as identity.** No `name` field, no per-node override. In Logseq the
  user chose per node by typing the citekey as the name; here the equivalent
  choice is per class (one decision, not hundreds).
- **FTS index changes.** `search_index` stays content-only; property matching
  is a query-time probe (below).
- **Sort-by-name semantics.** `name` sorting and `name:` query operators stay
  content-based — citekeys don't collate like titles.
- **Per-node template overrides.**

## Decision 1 — `displayTemplate` on the class (wire change)

One new additive optional field on `class.create` / `class.update`, following
the exact `parentlessRole` payload contract (`packages/protocol/src/op-types.ts:240,259`):
presence writes, present-null clears. Three states, one wire field:

| Wire value | Meaning |
|---|---|
| absent | **Inherit** — resolve the nearest extends-ancestor's template |
| `""` (empty string) | **Opt out** — no template for this class's members, even if an ancestor carries one; renders as plain title |
| non-empty string | **Own template** — literal text + `{{schemaName}}` placeholders |

Storage: one derived column on `class` — `NULL` = inherit, `''` = opt-out,
non-empty = template. No state column. Extends-resolution is read-time and
extends-aware (own value wins; absent walks the extends ancestors; `''` stops
the walk), mirroring the effective `parentlessRole` demote.

Template grammar: literals + `{{propertySchemaName}}` placeholders. Validation
is **write-time loud** (the impossible-states law): at `class.update` time,
every placeholder name must resolve to a property schema **available to the
class** (extends-aware scope eligibility, the same machinery as
`property.set`). Unknown or ineligible placeholder names fail the op — never
apply, never render-garbage.

Render-time fallback: each placeholder resolves to its effective value on the
node (the effective read model — authored ∪ binding default), flattened to
text like the property panel shows. Empty-valued placeholders render as empty
strings; **if the fully-resolved template is empty after trimming, fall back to
the content-flatten title** (the agreed fallback). Multi-value properties
render their values comma-joined.

## Decision 2 — where the template applies (render surfaces)

The template applies to **reference chrome only**: mention chips, node links,
pickers, backlinks, breadcrumbs, search-result rows, graph labels. A node's
**own page header keeps showing its editable content** — editing chrome must
show the title-is-content truth. `deriveDisplayName` / `fullTitleOf`
(`packages/domain/src/node.ts:163`) grow an optional
`resolveDisplayTemplate(classId)` input; surfaces pass it, unit tests cover
both branches. Date-node formatting is untouched (date chain never carries
classes with templates — the date class-set is frozen).

## Decision 3 — search surfacing (derived-side only, no wire change)

Three seams, all query-time derivation over the existing effective read model:

1. **DSL fields.** `citekey:<term>` and `author:<term>` compile to the shipped
   `property` condition over the seeded source-family schemas (citekey;
   authors). Removes both `citekey:`/`author:` entries from the "Deferred"
   section of `packages/query/README.md`.
2. **Bare-term fan-out.** Quick/global search (CommandPalette, NodeSelector,
   SearchPage) and `@`-mention suggestions all search through ONE store-side
   seam — the ranked FTS helper `searchNodes` (`packages/store/src/search.ts`)
   behind `client.search`/`client.searchPage` — which does NOT go through the
   query AST. **Mechanism amendment (2026-10-29, plan-time discovery):** the
   fan-out is implemented inside `searchNodes` — an OR probe over authored
   `property_value` rows (CAST(value AS TEXT) substring match, tombstone- and
   inactive-filtered with the same predicates the compiler uses), merged into
   the ranked result below FTS hits, deduped by node id. No new query-AST
   condition: collection filters/server `/query` keep the shipped `property`
   condition, and the search half of this spec ships with ZERO protocol
   change. The probe is authored-rows-only (binding defaults are query-time
   derived, never materialized); the only seeded default in the fan-out's
   reach is citekey's `""`, which carries no search value — an accepted,
   documented narrowing of "effective" for the search surface.
3. **`@`-mention resolution.** Mention search probes property values too, so
   `@doe2024` resolves by citekey and `@doe` by author — the muscle-memory
   path from Logseq/Zotero.

Personal-scale SQLite assumption: the fan-out is one bounded extra probe per
quick search; if profiling ever disagrees, the escape hatch is restricting the
probe to text-typed schemas (one-line compiler change, no model change).

## Decision 4 — seeds + convergence

- The `source` system-class seed ships `displayTemplate: "@{{citekey}}"`.
- The AV family (`film`, `tv_broadcast`, `audio_recording`, `radio_broadcast`,
  `podcast`, `video_recording` — final list follows the landed roster) plus
  `book` ship the opt-out `""` per the owner's request; every other class in
  the 39-class roster inherits. The list is one line of seed data to change.
- Existing workspaces converge via `scripts/migrate-display-template.mts`:
  Path A appended envelopes (relay log never edited), idempotent, dry-run by
  default, `--apply` writes + verifies against a fresh scratch store — the
  `migrate-seed-pins.mts` shape. Seed changes gate the GTK/Flutter lockstep +
  fixture gate exactly like the pins migration did.

## Wire/fixture/lockstep obligations

- Envelope **v3**, additive optional key — the `parentlessRole`/`pinned`
  precedent, no version bump, retired-key rules unchanged.
- Protocol fixtures: `class.update` round-trip (set/clear/`""`), extends
  inheritance + opt-out stop, write-time validation rejections (unknown
  placeholder, ineligible placeholder).
- The fixture gate + TS reference applier + GTK/Flutter lockstep land in the
  same slice (law 10) — no client may ship a parser that drops the field.
- Query fixtures: `citekey:`/`author:` DSL, bare-term fan-out across types
  (string/number/date), mention-resolution probe.

## Testing

- Domain: derivation matrix — own template, inherited, opt-out, unvalued
  placeholder → title fallback, multi-value join, `DISPLAY_NAME_MAX` cap.
- Store/applier: tri-state column transitions; template validation loud
  failures.
- Query: DSL fields, fan-out condition, coercion parity with `property`.
- Web: template-aware chrome on the reference surfaces; header stays
  content; quick search + mention probes.
- Migration script: dry-run report, apply + scratch-store replay verification.

## Risks / known costs

- **Reference chrome diverges from the page header** for templated classes —
  deliberate (Zotero-like reading), documented in SCHEMA.md.
- **All-property fan-out** adds one probe per quick search and lets numeric
  values match bare terms — accepted by decision; documented escape hatch
  above.
- **Template/placeholder drift**: renaming a property schema orphans a
  template placeholder. Write-time validation makes this loud at class.update,
  but an out-of-band schema rename could leave a dangling placeholder — the
  render fallback (placeholder → empty → title if all-empty) degrades
  gracefully; SCHEMA.md documents that templates reference schema NAMES and
  are the class owner's responsibility.

## Docs (same-pass obligations)

`packages/protocol/SCHEMA.md` (new class field + render contract),
`packages/query/README.md` (DSL fields move from Deferred to shipped),
`docs/developers/` runbooks where they describe display derivation or search,
user-facing `docs/` if the search behavior is user-visible (it is),
`CHANGELOG.md` entry on landing. `AGENTS.md` gains no history; its invariants
section is edited only where this spec changes stated law (it doesn't — the
render layer composes with title-is-content).
