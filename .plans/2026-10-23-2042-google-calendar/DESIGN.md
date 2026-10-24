# Google Calendar-level calendar (proposal, owner 2026-10-23)

The calendar graduates from a day-view with an events list to a full grid
calendar — Google Calendar's register, whole-day per the dates law (no clock
times). Grid-first, event blocks colored by `effectiveNodeColor`, a
Day/Week/Month/Year zoom ladder, drag-and-drop editing and creation, and the
recurring-event edit/delete semantics every calendar app ships: **"Only this
event" / "This and following events" / "All events"**.

## Why this is possible without wire changes

Everything rides existing machinery:

- The grid projection already exists (deterministic day nodes; date refs and
  range ends fan to the day node at projection time; recurrence expands at
  read). Blocks are a rendering of `eventRowsForDays` + ranges.
- Event color: `effectiveNodeColor` (own color → first class's effective
  color) — the owner's exact ask.
- Drag edits are ordinary ops: a date move is `property.set` on the date
  value; embedded-block moves are `object.move`; creation is `object.create`.
  Undo rides the session undo journal.
- The zoom scopes (`calendarEventsZoom`, the events element) shipped
  2026-10-23 and become the read model for grid blocks at every level.

## The model gap: recurrence exceptions

Today's recurrence is ONE node whose date value carries the rule
(`metadata.repeat`, RRULE-lite grammar, SCHEMA.md "Recurrence"); occurrences
are virtual; editing the node edits the series. Google semantics need an
exception model. Additive metadata on the same date value — the
`completedOccurrences` precedent, no op, no wire change, no fixture gate
(app-level metadata; the seed/lockstep law is not triggered — clients that
don't read the new keys converge byte-identical):

- `exdates: string[]` (local ISO days) — occurrences removed from the series:
  a single deleted occurrence, or a day whose occurrence was edited into an
  exception node. Absent/null = none; malformed throws (fail loud).
- `until: string` (one local ISO day, inclusive last occurrence) — the series
  bound written by a "this and following" split. Absent/null = unbounded.

`occurrenceIsosOf` filters exdates and `until` (a series carries them via a
new `recurrenceSeriesOf(metadata, anchorIso)` assembly — the existing
`{rule, anchorIso}` call sites switch to it, so every surface (events
element, grid dots, tasks) honors exceptions in one move).

### The three scopes, concretely (delete and edit share them)

Given a recurring series node N with date value V (anchor A, rule R), acting
on occurrence day D:

- **All events** — the existing behavior: mutate/trash N itself.
- **Only this event** —
  - delete: `exdates += D`; N keeps R.
  - edit: write the edit onto a NEW exception node E (content, classes,
    authored properties copied from N; the driving date value rewritten to
    the edited day, NO rule) and `exdates += D`. E is an ordinary
    non-recurring event afterwards — no dialog on its own edits (Google's
    detached-instance semantics). Children stay on the series (ruling: an
    exception is the node's own row; sub-blocks belong to the series — the
    exception is one day, the body is shared).
- **This and following events** —
  - delete: `until = P` where P is the last occurrence of (A,R) before D.
    When P does not exist (D is the first occurrence) the scope degenerates
    to "All" and applies as such.
  - edit: truncate with `until = P`, then create the continuation node C:
    copy of N with the edits applied, anchor = D (or the edited date), rule
    R verbatim. (A,R,exdates) occurrences before D keep N's exceptions;
    C starts clean (Google's split semantics).

## The plugin mapping substrate (owner requirement 2026-10-23)

Importers and sync plugins (calendar providers, Readwise, read-it-later)
need a durable **external → internal id mapping** — a Google event UID, a
Readwise highlight id, a read-it-later entry id resolving to the notees
node uuid, so re-runs update instead of duplicating.

- **Durable home: the operation log** — not a device table (derived SQLite
  DBs are wipe-rebuildable; the mapping would die on rebuild) and not
  per-user server prefs (the wrong scope: mappings are per-workspace,
  plugin-owned). Log-carried mappings sync to every device, ride the
  backup, and converge by LWW.
- **Wire**: a minimal additive op family — `external_ref.set {ref,
  nodeId}` / `external_ref.delete {ref}` — LWW per namespaced key.
  `ref` = `<provider>:<kind>:<externalId>` (e.g. `gcal:event:<uid>`,
  `readwise:highlight:<id>`, `readitlater:entry:<id>`). 1:1 per ref (a re-
  set moves the mapping); a node may carry many refs (the same event in
  Google and Outlook). Triggers the fixture gate + GTK/Flutter lockstep
  like any new op (own slice, before provider sync lands).
- **Derived read**: one `external_ref` table (ref PK, node_id, applied
  HLC); hard-deleting a node cleans its rows (the subtreeIds pattern in
  the appliers). Client reads: `resolveExternalRef(ref)`,
  `externalRefsOf(nodeId)`.
- This is what makes Readwise-style imports exactly idempotent — match by
  external id, never by title/content.

## Slices

1. **Recurrence exception model** — domain: `exdates`/`until` readers +
   metadata writers (`withExdate`, `withUntil`), `recurrenceSeriesOf`,
   expansion filtering. `calendarRecurrence.ts`: `deleteOccurrence` and
   `editOccurrence` (the three scopes, the split/exception writes).
   `recurringRowsOf` and friends switch to the series assembly. Tests +
   SCHEMA.md + calendar.md + CHANGELOG.
2. **Grid month view with event blocks** — the calendar view becomes
   grid-first: month grid renders event blocks (effectiveNodeColor, title
   clipped, multi-day ranges span), day-number click opens the day page
   (owner ruling). Zoom ladder Day/Week/Month/Year (week = 7 day-columns of
   stacked blocks; year = 12 mini-months). The events element retires into
   the grid (or becomes the Day zoom's panel, owner call at review).
3. **Drag and drop** — move a block between days (recurring blocks ask the
   scope; plain blocks rewrite the date); drag across empty grid area
   creates an `event`-classed node spanning the dragged days; drag handles
   extend multi-day ranges. dnd-kit (the outliner's drag stack).
4. **Scope dialog UI** — the "Only this / This and following / All" sheet on
   edit and delete of a recurring block (context menu entry points on grid
   blocks), the split/exception copy made live.

## Rulings baked in (owner-reviewed at each landing)

- Whole-day stays (the dates law): no clock times, no hour slots. Week view
  stacks whole-day blocks in 7 columns.
- Event creation class: the plain system `event` class (class it afterwards
  with the `+` picker); no creation-class popup.
- Drag-to-create spans days only (a range value), not times.
- Exceptions are single nodes (no child clone) — revisited if the owner
  misses series body edits on exceptions.
- Provider sync (public iCal subscribe, CalDAV) is OUT of this proposal —
  a later plugin slice; the op-log ingest path (import/checkpoint precedent)
  is where it lands.
