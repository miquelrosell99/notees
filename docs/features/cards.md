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
`/cards/review` with no stored session falls back to all due cards — the
review surface's own contract.
