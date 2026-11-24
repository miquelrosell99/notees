# Task-management gaps program (proposal)

Owner decisions (2026-11-24): in-app-only reminder delivery · Google Tasks
reminder model (the reminder rides the task's own Scheduled/Deadline
datetime; all-day tasks notify at a configurable default time) · GTK Tasks
hub is a follow-up lane, not this program · slices land web-first in the
order below, each its own gated/changelogged/deployed slice.

## Gap inventory (from the 2026-11-24 audit)

1. **Priority drives nothing** — `taskPriority` is seeded (Low/Medium/High/
   Urgent) but unpinned (renders below the pinned Status/Scheduled/Deadline
   tier) and the Tasks hub buckets ignore it entirely.
2. **No unreviewed-days queue** — named "Not shipped" in
   `docs/features/calendar.md`; overdue tasks just accumulate in the hub's
   Overdue bucket with no review flow.
3. **No reminders** — nothing fires when a task's Scheduled/Deadline moment
   arrives; the only notification machinery is in-app toasts.
4. **Capture-gesture target resolution + no global create-task chord** —
   verb capture's target resolution is designed-not-built
   (`docs/feature-status.md`); templates.md names the missing
   create-with-template chord.
5. **GTK client has no task surface** — follow-up lane (owner ruling above).

## Slice 1 — Priority surfacing

- Seed: pin `taskPriority` onto the task family binding (joins the
  Status/Scheduled/Deadline pinned tier). Lockstep law 10: check GTK
  `features.py` + Flutter `system.dart`/`local_workspace_seed.dart` in the
  same slice; live workspaces converge by a Path A script modeled on
  `scripts/migrate-seed-pins.mts` (append-only `class.property.set`
  envelopes, dry-run default).
- Hub: bucket rows show the priority (the option's circle/color register)
  and each open bucket sorts by priority (Urgent → Low, unprioritized last),
  then by the bucket's existing day ordering. Unpinned-from-seed note:
  `showInNodeRows` stays off — priority rides the hub, not every node row.
- Docs: `docs/features/tasks.md`, CHANGELOG.

## Slice 2 — Unreviewed-days queue

- The parked Google-calendar DESIGN.md does NOT spec it (checked
  2026-11-24 — only named "Not shipped" in calendar.md), so the design
  below is this slice's proposal, built to the repo's derived-state laws.
- Surface: a second registered collection view on the tasks hub —
  **Review** (the bucketsView.tsx registry-seam precedent; the switcher
  offers Buckets / Review / the shared modes). Rides the collection's
  filtered item set like every mode.
- Content: past days (driving day < today), oldest first, each carrying
  ≥1 open task — grouped BY DAY (the slipped day's header links the day
  page) with the standard task rows (done checkbox, priority/status pills)
  under it. Recurring tasks never appear (they roll forward, never go
  overdue — the calendar law).
- Gestures: the checkbox completes (the hub's exact write); a day-level
  **Push to today** rewrites taskScheduled → today for the day's
  scheduled-driven tasks ONLY (a deadline is a commitment — pushing it is
  a per-task decision, never a bulk one); rows open the task.
- NO stored "reviewed" bit: the queue is fully derived — a day leaves it
  when its open tasks are closed or rescheduled out of the past. (Device
  state is never an op; a cross-device review marker would be op-log state
  the model doesn't need.)
- Docs: `docs/features/tasks.md` + `calendar.md` (the "Not shipped" line
  retires), CHANGELOG.

## Slice 3 — In-app task reminders (Google Tasks model)

- Reminder time = the task's Scheduled (else Deadline) datetime's own
  clock time; all-day values (no time) fire at a configurable default
  (Settings → Tasks row, default 09:00). Done/Cancelled tasks never fire.
- Delivery: in-app toast through the kit's notification store + optional
  browser Notification API (permission requested from the settings row).
  Fired-state is device-local (localStorage; "device state is never an
  op") so a reminder fires once per device per task-moment.
- Scheduler: a web-client module that subscribes to the effective
  Scheduled/Deadline/Status reads, arms timers for the next firing moments,
  re-arms on change, and catches up missed-since-boot moments on load
  (fire once if the moment passed today and the task is still open).
- No protocol/seed/wire change — no fixture gate; sibling-client check
  recorded (GTK/Flutter author no reminder code; values are ordinary LWW
  state they already read).
- Docs: `docs/features/tasks.md` (the reminders section), settings docs,
  CHANGELOG.

## Slice 4 — Create-task chord (target resolution DESCOPED)

- **Target resolution is blocked by a standing owner decision**: SCHEMA.md's
  designed-not-built register says "Typed-link target-resolution design —
  DEFERRED by owner decision; register only, do not spec. Design against
  the recorded candidateSpans." The typed_link wire grammar carries NO
  target field (`verb`, `text`, `metadata{locator?, candidateSpans?}`), so
  resolution is a wire change + fixture gate + GTK/Flutter lockstep on top
  of the deferred design. Not built; reported to the owner. Lifting the
  deferral is the owner's call.
- **The chord ships**: Ctrl/Cmd+Alt+N (the N-row register: plain N new
  page, Shift+N quick add, Alt+N task — Shift+N was already taken).
  `taskChordHandler` keymap factory + the hub's New flow extracted into a
  shared `useTaskCreate` hook (HubView + App both ride it; the chord can
  fire before the hub ever opened, so the flow ensures the task family
  first). Templates picker when the task class binds templates, direct
  unscheduled create otherwise.

## Follow-up lane (not this program)

- GTK Tasks hub (`clients/gtk`, Python/GTK4, `gtk-v*` tag) — own slice
  after the web program lands.
- GTK `pinned` machinery port: its strict `ClassPropertySetPayload`
  predates the `pinned` key (rejects it — the documented LOCKSTEP-PENDING
  debt), so `migrate-seed-pins.mts --apply` (incl. the 2026-11-24 priority
  pin) stays gated until the port lands: payload field + store column +
  applier write + fixture replay.

## Per-slice discipline

Worktree per slice (`.worktrees/<slug>`), scoped gate during the loop, full
root gate pre-landing, CHANGELOG entry in the same pass, per-file staging,
Conventional Commits, land on main (fetch/rebase/ff), redeploy the web
image + verify-min smoke via the notees-operations skill, watch the publish
run to completion.
