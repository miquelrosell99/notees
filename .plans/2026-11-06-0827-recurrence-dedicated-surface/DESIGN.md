# Recurrence as a deliberate, dedicated surface

2026-11-06 · Status: proposed (design approved in session; awaiting spec review)

## Intent

Recurrence in Notees today is an affordance, not a decision: every day-precision
datetime property value carries a ⟳ RepeatPicker (`DatetimePropertyRow`, the
`DatePickerPopup` Repeat row, `DateSlotControl`), and the calendar's recurrence
scan (`recurringRowsOf`) reads `metadata.repeat` off **any** authored datetime
value on **any** page. Setting "Repeat: Yearly" on a source's Publication date
silently turns the source into a recurring series that paints every occurrence
day in the calendar. The storage is invisible to queries, the CLI, and the API
schema, and one stray rule can shadow a legitimate series ("first repeating
date value wins").

The fix, in the Google register: recurrence becomes a **deliberate, dedicated
surface** — a Repeat control that exists only where recurrence is meaningful
(event family, tasks), authored as its own thing, with the expressive grammar
Google ships (interval, weekdays, day-of-month, authorable ends). Not nested in
the date property, not offered on every date.

This supersedes the **storage half** of the shipped google-calendar proposal
(`.plans/2026-10-23-2042-google-calendar/` — `metadata.repeat` as the rule's
home). The occurrence-semantics register that proposal established — only this /
this and following / all, exdates, until-truncation, per-occurrence completion —
is preserved verbatim; only where the state lives changes.

## Decisions (agreed in session)

1. **Full Google register**: a dedicated recurrence property on the event and
   task classes — not a metadata string on date values, not a separate system
   object.
2. **Grammar**: FREQ + INTERVAL + BYDAY + BYMONTHDAY, plus authorable ends
   (COUNT / UNTIL). No BYSETPOS ("third Tuesday") in v1.
3. **Surfaces**: Properties panel Repeat row + the calendar event-creation
   modal. Removed from the generic date picker popup and date-slot controls.
4. **Wire shape**: an ordinary **text-typed system property** whose value is an
   RFC 5545 RRULE string. No new property TYPE. Rationale: a SCHEMA.md type is
   forever (every projection, GTK/Flutter lockstep); Google itself ships RRULE
   strings; RRULE is a lossless serialization of the supported subset, so a
   structured type later is a pure parse, mechanical and cheap. The direction we
   are choosing is the reversible one.

## Model & wire (`notees-sync`)

### The Repeat property

- New system property schema, text type, **single-value**, self-healed at a
  fixed id (new `SYSTEM_PROPERTY_UUIDS` entry), display name **Repeat**.
- Bound to the `event` and `task` system classes. Everything extending them
  (`meeting`, `birthday`, task subclasses) inherits the binding; a source's
  Publication date can never carry it.
- **`scopeClassIds = [event, task]`** — scope is the locality authority, so
  CLI/API writes of Repeat onto a non-event/task node are rejected fail-loud at
  write time. This is what makes the capability deliberate: the property system
  itself refuses the leak, not just the UI.
- Seed **unpinned** (the pinned roster is a declared, migration-gated ruling;
  bound-but-empty rows already render virtually, so no seed-ruling churn is
  needed for visibility).

### The grammar (canonical "RR5" subset)

Stored value: `RRULE:` + properties in **one canonical order** — `FREQ`,
`INTERVAL` (omitted when 1), `BYDAY`, `BYMONTHDAY`, then the end (`COUNT` or
`UNTIL`, mutually exclusive). Keys uppercase, values uppercase, lists
comma-joined in fixed order (BYDAY: MO,TU,WE,TH,FR,SA,SU). Examples:

- `RRULE:FREQ=DAILY` — every day
- `RRULE:FREQ=DAILY;INTERVAL=2` — every 2 days
- `RRULE:FREQ=WEEKLY;BYDAY=MO,FR` — every Monday and Friday
- `RRULE:FREQ=MONTHLY;BYMONTHDAY=3` — every 3rd of the month
- `RRULE:FREQ=YEARLY` — every year on the anchor date
- `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=10` — ends after 10 occurrences
- `RRULE:FREQ=MONTHLY;UNTIL=20261231` — ends on a date

Semantics:

- `FREQ`: DAILY | WEEKLY | MONTHLY | YEARLY (required).
- `INTERVAL`: integer ≥ 1 (default 1).
- `BYDAY`: weekday list; WEEKLY without BYDAY recurs on the anchor's weekday.
- `BYMONTHDAY`: day-of-month list; MONTHLY without BYMONTHDAY recurs on the
  anchor's day-of-month.
- `UNTIL`: inclusive end day, day-precision (`YYYYMMDD`).
- Anything outside the subset (BYSETPOS, WKST, BYMONTH, …) **fails loud at
  parse** — corrupt rules throw, never read as plain. This is the house idiom.

The grammar, canonicalizer, parser, and expansion live in `packages/domain`
(the current `calendarRecurrence` grammar readers move there or are replaced),
with round-trip and expansion tests under the fixture gate.

### Exceptions and per-occurrence state

Still value metadata — now on the **Repeat value** instead of the date value:

- `exdates`: deleted/skipped occurrence days (only-this deletions, detached
  edits).
- `until`: series truncation day (this-and-following splits). Authorable via
  the Ends control; also written by occurrence edits as today.
- `completedOccurrences`: per-occurrence done days for repeating tasks.

One node contributes at most one series: its Repeat value (if present) wins.

### Anchor

The series anchor is the **driving date value's day**: the authored `eventDate`
value (event family) or `taskScheduled` value (tasks). No driving date → the
web Repeat control renders disabled with a "set a date first" hint. A Repeat
value whose anchor day cannot be resolved reads as a series that occurs nowhere
(fail-loud parse still applies to the rule itself).

### Migration

New log migration `scripts/migrate-repeat-property.mts` (rehearsal-gated like
its siblings):

1. Every authored datetime value carrying `metadata.repeat` (grammar strings
   `daily` | `weekly` | `weekdays` | `monthly` | `yearly`, plus the
   API-authored interval form `weekly/2` etc.): convert to the canonical RRULE
   (`daily`→`FREQ=DAILY`; `weekly`→`FREQ=WEEKLY` on the anchor weekday;
   `weekdays`→`FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`; `monthly`→`FREQ=MONTHLY` on
   the anchor day; `yearly`→`FREQ=YEARLY`; `<freq>/<n>`→`FREQ=…;INTERVAL=n`)
   and write the Repeat property value on the node.
2. Move `exdates` / `until` / `completedOccurrences` from the date value's
   metadata to the Repeat value's metadata.
3. Strip the old keys from the date value.
4. Nodes whose class does not reach event/task after the move: the migration
   reports them (they predate scope enforcement); the write is still applied —
   existing graph state is grandfathered, but new writes are refused.

No new op type: Repeat is authored with ordinary `property.set` on a text
schema. Op fixtures exercise the applier path for the new seed + scope.

## Surfaces (`notees-web`)

### RepeatControl (new kit component)

One independent component under `components/ui/kit/`, token-only CSS,
co-located styles, barrel-exported — per the ui-primitives law. Used by both
surfaces:

- Off state: a single **Repeat** toggle/row (off by default).
- On: *"Repeat every [n] [days|weeks|months|years]"*; weeks → weekday chips;
  months → day-of-month; **Ends:** Never / after [n] occurrences / on [date];
  a live summary line above the controls ("Every 2 weeks on Mon, Fri · ends
  after 10 occurrences").
- Disabled with a "set a date first" hint when the node has no driving date.
- Client-side validation before write: interval ≥ 1, at least one weekday,
  monthday in 1..31, end not before the anchor, COUNT ≥ 1.

### Where it renders

1. **Properties panel**: the Repeat property gets a dedicated row renderer
   (registered by the repeat schema id — the default text row would render a
   bare "Type something" input, which is exactly the implicitness this design
   removes). Bound-but-empty renders dimmed with the from-class hint like any
   virtual class property.
2. **Event-creation modal** (the calendar ghost's more-button modal): the same
   control, writing the property at create time.

### Removals

- `RepeatPicker` off `DatetimePropertyRow` (single + multi branches) and out of
  the `DatePickerPopup` Repeat row; the popup's `repeat`/`onRepeatChange` props
  go.
- `DateSlotControl` loses its repeat props and rider. Date properties become
  purely "when"; a re-pick can no longer carry a rule (there is none there).

### Consumers rewired

- `recurringRowsOf` scans the **Repeat property** (authored value + metadata),
  not datetime metadata. One node = one series holds.
- The task partition (`calendarViewUtils`), "never Overdue / rolls forward",
  and per-occurrence completion read/write the Repeat value's metadata.
- `calendarRecurrence` (edit/delete occurrence scopes) writes `exdates`/`until`
  on the Repeat value; the occurrence-detach copy carries the Repeat property;
  the series assembly (`recurrenceSeriesOf`) takes the rule from the property
  value and exceptions from its metadata.
- The calendar block's recurrence indicator reads the property.

## Errors

- Corrupt RRULE / exdates / until / completedOccurrences: **fail loud** at read
  (throw), never silently plain.
- Write-time validation in both surfaces (control-level); API/CLI writes of a
  garbage rule are not pre-validated beyond property scope — they fail loud at
  read and are visible/fixable, per the text-property trade-off accepted above.
- Repeat on a class outside event/task: refused at write by scope enforcement.

## Testing

- `packages/domain`: grammar round-trip (author → canonical string → parse →
  same object), expansion (occurrences in a window, interval, BYDAY,
  BYMONTHDAY, COUNT, UNTIL, exdates), fail-loud cases. Under the fixture gate.
- Migration rehearsal: the new script + fixture covering every old grammar form
  (incl. `weekly/2`), metadata moves, and the grandfathered out-of-scope node.
- Web vitest: rewired consumers (recurring rows, task partition, occurrence
  edits, per-occurrence done), the removal (no repeat affordance renders on
  ordinary date rows — a Publication date row is the regression probe), the
  RepeatControl (summary line, ends, validation), modal integration.

## Docs & records

- `SCHEMA.md` "Recurrence" rewritten (property + RR5 grammar + exception
  metadata), seeds section, scope ruling.
- Web repo `docs/`: `properties.md` (Repeat row; picker loses the Repeat row),
  `calendar.md`, `tasks.md`.
- `CHANGELOG.md` entries in both repos as slices ship. No transient pointers to
  this plan from the tree.
- AGENTS.md in both repos: only where the guidance itself changes (seed roster
  mention in the sync repo's pinned-roster ruling if Repeat's pin tier changes —
  it does not in this design).

## Slices

1. **Core**: RR5 grammar + canonicalizer + expansion in `packages/domain`;
   Repeat seed (id, bindings, scope); migration script + rehearsal; SCHEMA.md;
   fixtures + gate. Lockstep-gated (TS reference + GTK/Flutter/CLI fixtures).
2. **Web consumers**: vendor bump, then the consumer rewiring + removals with
   the regression probe (Publication date row renders no repeat affordance).
3. **Web surfaces**: `RepeatControl` + the panel/modal integrations + docs.

Slices 1–2 must ship together (the web reads what the core writes); slice 3 can
follow independently — between 2 and 3 the old surfaces are gone and the new
one is not yet there, so 2 and 3 land in one release train.

## Out of scope (v1)

- BYSETPOS ("third Tuesday") and BYMONTH.
- Per-occurrence time overrides (the anchor value's clock time still rides
  every occurrence, as today).
- Multiple independent series on one node.
- Repeat on classes beyond event/task (a user class extending event gets it
  through the extends chain — that is the only path).
- Import of foreign iCal RRULEs beyond the RR5 subset (they fail loud, as any
  unsupported rule does).
