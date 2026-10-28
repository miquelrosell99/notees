# Cards

The memorization-cards surface: class any node as a **card** and the Cards
hub (`/cards`, the sidebar's Cards row) becomes its home — the SRS schedule
properties, the due/fresh/later buckets, and the Review actions that hand a
session off to the review surface at `/cards/review`.

## The hub

`/cards` lists every node classed `card` (pages and blocks alike — the
tasks-hub rule) in the shared hub chrome: table (default), cards, or
outline; the view mode persists device-locally. Above the collection:

- **The filter bar** — the transient query builder (quick text + the
  structured condition panel) shared with every collection. An active
  draft narrows the hub's list; nothing persisted, the default is every
  card.
- **The bucket strip** — three counts computed client-side from the
  effective `Card due` value: **due** (the `cardDue` day is today or
  earlier), **fresh** (no `cardDue` value — never reviewed), **later**
  (a future `cardDue` day).

The header carries the scheduler toggle (FSRS, the default, or SM-2 — the
per-user `cards.algorithm` preference from Settings), a **Review** button
that starts a session over the current filtered list, and **New** (a fresh
`card`-classed node, opened). Every row also wears a trailing Review action
for a single-card session.

The six schedule property schemas (`Card due`, `Card reps`, `Card
interval`, `Card ease`, `Card difficulty`, `Card stability`) self-heal on
first hub open — the `ensureTaskFamily` precedent: reserved seed ids,
global scope, per-class bindings, a no-op once present.

## The review handoff

A Review gesture stores `{ cardIds, filterSummary }` in session storage
under `notees.cards.session` and navigates to `/cards/review` — the review
surface renders there (a card-id list is session state, not a shareable
address, so it never rides the URL). The bucket strip's Review action
covers the due + fresh sets; the header's Review covers the current
filtered list; a row's action covers that card. A deep link to
`/cards/review` with no stored session falls back to every card-classed
member — the queue is due + new only, so the session is exactly the
reviewable set.

## The review session

`/cards/review` is the study flow. The session consumes the stored hand-off
(and clears it — a later deep link must not resurrect a stale session);
with no session it covers every card-classed member. The queue is **due +
new only** (`buildReviewQueue`): due cards first (due-date ascending —
overdue ahead of due-today), then fresh (never-scheduled) cards in input
order. A card with a future due date is not reviewable yet and never
enters the session — a hand-off may carry such ids, the queue drops them.

Each card renders front-first: the card node's own content, read-only.
**Reveal** flips to the back — the same content plus the card's embedded
children in the condensed prose layer — and the four-grade bar appears
(Again/Hard/Good/Easy, keys 1–4). A front-only card (no embedded children)
renders an explicit "No answer on this card" empty state and still grades.

Grading computes the next SRS state with the session's algorithm (read
once at session start from the `cards.algorithm` preference) and writes it
into the six schedule property values as ONE undo gesture (`reviewCard`) —
`Card due`, `Card reps`, `Card interval`, and the active algorithm's
`Card ease` (SM-2) or `Card difficulty`/`Card stability` (FSRS); the
inactive algorithm's fields stay stale (the mid-deck switch contract), and
one undo reverts the whole grade's schedule writes. The `card.review` op
records the full state transition as audit history — grouped under one
session id — and is **never undoable**: undoing a grade reverts the
property writes through the per-tab undo journal, the history row stays. The session ends with a
summary (cards reviewed, lapses — an Again on a card with reps) and a
back-to-cards action; the exit is a real history push, so the in-app back
arrow returns to the hub.

The surface owns its URL and tab title (law 9): `/cards/review` deep-links
straight into a session and the tab reads "Review - Notees".
