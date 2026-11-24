# Task-management tier 2 (proposal)

Owner decisions (2026-11-24): mobile = Android first (widget + quick-add +
lock-screen reminders; iOS a later lane) · calendar sync = ONE-WAY
subscribe (iCal/CalDAV read → event nodes via the op-log ingest path, no
OAuth, no write-back) · NL dates = English only · order: web slices →
Flutter lane → calendar sync.

## Slice A — One-tap postpone (web)

- **Push to tomorrow** on a single task: sets Scheduled to tomorrow,
  PRESERVING the value's clock time. Scheduled-driven rows only — a
  deadline is never postponed by this gesture (the bulk-review law);
  recurring tasks never show it (the series rolls).
- Surfaces: (1) a hover-revealed row action in the hub's buckets + Review
  rows; (2) the reminder toast gains a secondary action ("Tomorrow") next
  to Open — the kit Notification grows an optional `secondaryAction`
  (additive).
- One property write = one undo entry. Ensure the date chain for tomorrow
  before the write (the Review push precedent).
- Docs: tasks.md, CHANGELOG.

## Slice B — Natural-language dates (web, English)

- Pure parser `parseNaturalDate(input, now)` → `{ iso, time? } | null`:
  today/tonight/tomorrow/yesterday, weekday names (+ "next <weekday>"),
  "in N days/weeks/months", "<weekday>" (next occurrence), month-day
  ("dec 5", "december 5th"), "next week/month", time suffixes ("at 5pm",
  "at 17:00", "noon", "midnight"), combinations ("tomorrow at 5pm").
  Fail-closed: anything unparsed returns null (the caller keeps today's
  behavior).
- Integration: extend the EXISTING typed-date parsing the pickers/date
  editor already use ("feb 14" rows) so NL works everywhere a date is
  typed, one grammar. Time rides the value's `time` slot where the schema
  is day-precision (the eventDate precedent).
- Docs: properties.md/calendar.md as the surfaces dictate, CHANGELOG.

## Slice C — Flutter Android lane (RESCOPED after audit)

The audit correction: quick-add-from-phone (QuickNote/AudioNote tiles,
share receiver, capture bubble), the three home-screen widgets (today's
tasks, favorites, inbox), and lock-screen reminders (flutter_local_notifications
with exact alarms, snooze 15m/1h/Tomorrow, boot reschedule via Workmanager)
ALL already shipped — the tier-1 audit's "no quick-add/widgets/reminders"
claim was wrong. The genuine gap was date-rule drift: three private
deadline-only `_taskDueDate` copies (tasks screen, widget service, boot
reschedule) meant Scheduled-only tasks never reminded nor surfaced.
Shipped fix: shared `lib/domain/services/task_dates.dart` owning BOTH web
rules (display = earliest of Scheduled/Deadline; reminder = Scheduled wins
else Deadline), consumed by all three surfaces. Verified via dispatched
`flutter-android.yml` (the host SDK 3.44.6 predates the pubspec floor —
the 2026-11-17 precedent), CI green, landed f42c6ccb4.

## Slice D — Calendar subscribe (server, one-way) + the shared external-ref mapping

Owner addition mid-slice: the external-identifier ↔ node mapping is
GENERAL plugin infrastructure, not calendar-specific — shipped as the
`external_ref` coordination table (`external-refs.ts`:
(workspace, integration, external_id) → node + first/last-seen), the
calendar its first consumer (`calendar:<feed-url>`), registered in
plugins.md as the designed plugin-runtime service for read-it-later
providers, highlight importers, contacts importers.

## Slice D — Calendar subscribe (server, one-way)

Design decisions (2026-11-24):

- **Table** `calendar_subscription` (coordination state, the shares/prefs
  precedent — never op-log): id (uuidv7), workspace_id, url, name,
  timezone (IANA, default the server's zone), refresh_minutes (default 60),
  etag / last_modified (conditional GET), last_fetched_at, last_status.
- **Routes** (owner/admin, the shares gate; OpenAPI table updated):
  POST /api/calendars (add + immediate ingest), GET /api/calendars
  (list + status), POST /api/calendars/:id/refresh, DELETE /api/calendars/:id
  (removes the subscription; ingested events STAY — they are graph content
  now, documented).
- **Poller**: an interval sweep (the self-heal sweep precedent) refreshing
  due subscriptions with If-None-Match/If-Modified-Since; 304 touches
  last_fetched_at only.
- **Ingest**: through `ctx.submit` (the capture route's one write path).
  One event-classed node per VEVENT UID: id = UUIDv5(subscription, UID) so
  re-ingest is idempotent (create no-ops, property.set LWW-updates);
  SUMMARY = the title; DTSTART/DTEND → eventDate (all-day DATE → day slot,
  DTEND exclusive per RFC so subtract a day on ranges; DATE-TIME → day +
  "HH:MM" wall clock converted INTO the subscription's timezone via Intl);
  RRULE → the repo's RR5 subset when it maps, else the base event imports
  rule-less and the status line says so. Vanished UIDs are never deleted or
  archived in v1 (the feed is additive/updating — documented).
- **Guards**: E2EE workspaces rejected (the capture precedent), http(s)
  only, 5 MiB cap, 15 s timeout, operator/owner gate (SSRF posture: the
  owner subscribing to their own LAN Nextcloud is the feature).
- **ICS parser**: hand-rolled minimal VEVENT reader (unfold, UID/SUMMARY/
  DTSTART/DTEND/RRULE/LOCATION), fail-loud on malformed input, no new
  dependency.
- **Web UI**: Settings → new "Calendars" section (add url+name+timezone,
  list with status, refresh, remove).
- Docs: calendar.md (the subscribe section), api.md, OpenAPI, CHANGELOG.

## Per-slice discipline

Same as tier 1: worktree per slice, scoped gates in the loop, full gate
pre-landing (BUILD ALL FIRST — the CLI release-bundle test needs
dist/cli.js), changelog in the same pass, land on main, redeploy changed
services, watch the publish run.
