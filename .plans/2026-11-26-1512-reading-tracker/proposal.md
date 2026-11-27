# Reading Tracker — a first-class source-library feature

**Status:** Phases 0–3 SHIPPED 2026-11-27 (Phase 0 dogfood migration in Notas — 137 nodes; Phases 1–3: the settings toggle + seed, the detail-pane gestures, the CLI gestures, plus the kosync server and the KOReader docsettings connector); Phase 2's hub Group-by/facet remainder and Phase 4's docs landed the same slice. The owner overruled one open decision: the vocabulary ships in Spanish (`Estado`, `Primera lectura`, …) in the owner's workspace; the product seed uses the same Spanish names.
**Born from:** the owner's live reading workflow (peri-implantitis paper → notes → "have I read this?"),
the `Consumido`/`Consumiendo` boolean pair already in use on 138 source nodes in Notas, and the
question of how that should ship for every user.

---

## 1. The problem

The source library knows what a work IS (metadata, files, citekey) but nothing about the owner's
relationship with it. Reading state today is either absent or ad-hoc (in Notas: two boolean
properties, `Consumido` + `Consumiendo`, which are (a) capable of impossible states — both true at
once has occurred, (b) history-erasing — a re-read flips `Consumido` off, and (c) unable to say
*when*, *what part*, or *why not*.

The questions a reader actually asks:

| Question | Today's answer |
|---|---|
| Have I ever finished this? | maybe, if a boolean survived |
| Am I reading it now — first time or again? | no |
| When did I first / last finish it? | no |
| Did I drop it, and why? | no |
| What parts of this book have I read? | no |
| What am I reading right now, across the library? | no |

## 2. The design (data model)

Four user-extensible properties, created by the feature toggle (not system seeds — the toggle's
ensure gesture creates them idempotently, the sources-settings idiom), all scoped to the source
family, bound on `source` (inherited by all 39 type-classes):

### 2.1 `Estado` — select, the lifecycle state

`Pendiente / Leyendo / Consumido / Abandonado` — exclusive by construction, groupable in the hub.

- **Consumido** means *finished*, always. An abandon never wears the done badge.
- **Abandonado** is the deliberate stop: engaged, dropped, not done. The *why* is not a property —
  it is a note block under the source (content, in the owner's notetaking voice), same as the
  partial-read record.

### 2.2 Three datetimes, three write semantics

| Property | Set when | Updated? | Cleared when |
|---|---|---|---|
| `Primera lectura` | first completion | **never** (fill-once, forever) | never |
| `Última lectura` | every completion | always (LWW) | never |
| `Abandonado el` | transition to Abandonado | on re-abandon | leaving Abandonado (resume) |

The split is the point: *ever-read* can never be erased by re-reads or abandons (the failure of the
booleans), while *recency* tracks the latest completion. `Abandonado el` mirrors the state — a
stale abandon date on a finished book would be ruido.

### 2.3 Partial reads — blocks, not properties

"What have I read of this book" is content: child blocks under the source, one per
chapter/section/article, in the notetaking shape (`Cap. 3 — …`). They double as the landing zone
for per-part notes. An optional free-text `Progreso` ("Cap. 1–4") is an acceptable cache of the
blocks for scannable rows, never the record.

### 2.4 What it is NOT

- No reading-history table, no streaks, no page counters, no goals. History lives in blocks; the
  properties hold the current truth plus the two dates that matter.
- No stars/ratings — orthogonal (a future `Valoración` if ever wanted).

## 3. Product placement: Sources feature vs opt-in workflow

**Recommendation: inside the Sources feature, behind a Sources settings toggle** ("Seguimiento de
lectura" / Reading tracker), off by default.

Rationale:

- The state is *source lifecycle* — it belongs to the same surface that already owns citekeys, the
  resolver, and the library hub. A reader's "currently reading" is library metadata, not an
  automation, so the **workflow machinery** (rules, run audit) is the wrong home: workflows fire
  actions on triggers; reading tracking IS data. A `reading-workflow` could later *consume* the
  state (e.g. "nightly: list Leyendo items with no note in 14 days"), which is exactly the
  feature/workflow boundary the codebase already draws.
- The feature-toggle idiom exists and fits: like `resolverEnabled`, a `readingTracker` settings key
  gates the property seeding and the UI affordances; off = zero schema, zero chrome; on = the four
  properties + hub surfaces appear.
- The hub already has the group-by machinery — `Estado` groups the library into Pendiente /
  Leyendo / Consumido / Abandonado shelves with counts for free.

## 4. Comparison with popular reading trackers

| Capability | Goodreads | StoryGraph | Literal | Readwise Reader | Calibre | Zotero | **This proposal** |
|---|---|---|---|---|---|---|---|
| Read state (want/reading/done) | ✓ | ✓ | ✓ | partial (later/archive) | via plugin | ✗ (tags hack) | ✓ (4 states, exclusive) |
| Abandoned / DNF as a first-class state | ~ (shelve hack) | ✓ DNF | ✓ | ✓ (archive) | ✓ | ✗ | ✓ + abandon date + reason-as-note |
| First-read vs last-read dates | ✗ (one "date read") | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ both, distinct semantics |
| Partial progress (which chapters) | ✗ (% only) | ✓ pages-% | ✗ | ✓ (article progress) | ✗ | ✗ | ✓ chapter blocks, note-native |
| Queryable / structured data | ✗ (locked platform) | ✗ | ✗ | partial | local file | local file | ✓ typed properties + query language |
| Sits ON the bibliographic record | ✓ | ✓ | ✓ | ✗ (read-later tool) | ✓ | ✓ | ✓ citation-native, exports clean |
| Local-first / E2EE | ✗ | ✗ | ✗ | ✗ | ✓ local | ✓ local | ✓ op-log authority, E2EE workspace |
| Works for papers, books, video, podcasts | ✗ books | ✗ books | ✗ books | ~ articles | ~ books | ✓ everything | ✓ the whole source family |

Where the incumbents are better, honestly: Goodreads/StoryGraph own social (reviews, friends,
recommendations) — explicitly out of scope. Readwise Reader owns the capture pipeline — the
connector/capture API is that seam here. The differentiator no incumbent can copy cheaply: the
reading state lives in the same typed-property graph as the citations, the notes, and the query
language, so "papers I abandoned after the methods section", "books read in 2025 that cite X", and
"currently reading, sorted by last-read" are one query each — and all of it syncs offline-first.

## 5. Surfaces

1. **Sources settings** (Workspace → Features → Sources): the toggle; on-first-enable seeds the
   four properties + bindings (idempotent; archived on toggle-off, data preserved, the
   family-toggle precedent).
2. **Sources hub**: Group-by `Estado`; a "Leyendo now" facet/badge; the detail pane shows the
   reading rows with date pickers; the table columns optional.
3. **Source detail gestures**: mark-read (sets Consumido + both dates per semantics), abandon
   (prompts an optional one-line reason → note block), resume (clears `Abandonado el`).
4. **Notetaking integration**: the paper-notes flow's completion gesture ("notes landed") marks
   the source read — the moment notes and state stop being two rituals.
5. **CLI**: `notees source mark-read|abandon|resume <id>` riding the same property write paths
   (the `source` command group already exists).

## 6. Implementation plan

- **Phase 0 — dogfood migration (the owner's workspace).** Prod healed (gated on the drift-guard
  deploy having converged — VERIFY 189 schemas first). Create the four properties, migrate the 138
  boolean-carrying nodes (`Consumido`→Consumido+today on both read dates; `Consumiendo`→Leyendo;
  both-checked listed for the owner to decide), retire the booleans. Proves the semantics on real
  data before any product code.
- **Phase 1 — feature toggle + seed.** `readingTracker` sources-settings key; the ensure gesture
  (idempotent property create + bind, the family-toggle precedent); web settings section.
- **Phase 2 — hub + detail surfaces.** Group-by Estado, Leyendo facet, detail-pane rows and
  gestures (mark-read / abandon / resume with the reason-note).
- **Phase 3 — CLI + notetaking skill gesture.**
- **Phase 4 — docs.** `docs/features/sources.md` section (Today-vs-Designed honest register),
  settings docs, `docs/cli.md`.

Each phase lands as its own slice with the fixture/changelog/docs discipline; no wire/protocol
change anywhere (user-extensible properties only) — no client lockstep.

## 7. Verification

- Phase 0: per-node re-fetch sweep — every migrated node carries the expected state; boolean rows
  gone; hub group-by renders the shelves.
- Phase 1–2: web suites over the settings toggle (seeding idempotency, archive/re-enable), hub
  grouping, gesture write semantics (fill-once primera, LWW última, mirror abandon date).
- Phase 3: CLI suite specs; the paper-notes skill's completion gesture verified end-to-end on a
  seeded test workspace.

## 8. Open decisions for the owner

1. **Placement** — Sources-feature toggle (recommended) vs research-workflow. §3 argues the
   boundary; the call is yours.
2. **Property vocabulary** — `Estado`/`Primera lectura`/`Última lectura`/`Abandonado el` (Spanish,
   matching the owner's live pair) or English system names with Spanish display names? Fleet
   precedent favors English schema names + per-workspace naming freedom.
3. **Toggle default** — off (recommended; zero-schema until wanted) vs on for new workspaces.
4. **Phase 0 timing** — dogfood now, product code after a week of real use, or straight to Phase 1?

---

## 9. Parity roadmap — Notees vs the reading-tracker incumbents

Where Notees stands against Goodreads / StoryGraph / Literal / Readwise Reader / Calibre / Zotero
feature-for-feature, and what closes each gap.

### Bucket 1 — covered by this proposal (the tracking baseline)

The Goodreads core loop — read state, DNF, dates, partial progress. Ship §2 and the tracking
surface is at parity.

### Bucket 2 — schema-only wins (the model already owns the machinery)

| Gap | Cost | Notes |
|---|---|---|
| Ratings (`Valoración`, select or 1–5) | one property + hub column | StoryGraph parity |
| Reading goals/stats | hub stats strip (UI only) | "finished per year" is already a query over `Última lectura`; the date chain buckets it |
| Series (`Serie` + sequence) | text/select property | collection grouping exists |

Each is days, not weeks — the query/group/export machinery was built once and these ride it.

### Bucket 3 — real feature work, ranked by leverage

1. **Capture → tracker seam** (Readwise parity). The connector/capture API already saves "Read
   later" items; wiring *captured article → Pendiente source* closes the loop Readwise owns.
   Highest leverage: it feeds the tracker.
2. **Goodreads CSV importer** — the CLI import idiom (citekey-upsert precedent) over a Goodreads
   export. An adoption feature: the audience is people leaving those tools.
3. **Title-based book metadata** — the resolver covers ISBN/DOI/arXiv/PMID/ADS but not fuzzy
   book-title lookup; Open Library search closes the "just type the name" gap.
4. **Highlight/annotation import** — KOReader highlights already import (`notees-import`); Zotero
   annotation import and web-highlight sync (the Readwise moat) are the deeper cuts. The
   designed-not-built register deliberately excludes an in-app PDF reader — import is the honest
   parity route, not building a reader.

### Bucket 4 — deliberate non-goals (write them down as such)

- **Social** (reviews feed, friends, recommendations) — fights the privacy-first soul of the
  product; nobody has out-social'd Goodreads and the attempt would be the wrong game.
- **Ebook management/conversion** — Calibre's job.
- **Streaks/gamification** — ruido.

Parity ≠ cloning: the pitch is *your library as a queryable graph*, not another shelf app.

