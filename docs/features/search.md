# Search and the command palette

**Ctrl/Cmd+K** opens the command palette — workspace search, create rows, and the app's action registry in one surface — and **Ctrl/Cmd+Shift+F** opens the full-page search. Ranking, the query modes, and the global chords live here; the `@` mention picker (which opens to your Recently used nodes and narrows with `class:` filters) is [links.md](links.md)'s; full-text via the API is [api.md](../api.md)'s.

## The command palette

The search sections rank **Classes → Properties → Pages → Content** (Content = full-text hits with excerpts, block hits labeled by their page), then Date Pages and **Commands** — including a typed **Create page "…"** row for whatever you typed (a bare 4-digit **year outside the 1900..2200 date window** — 1711, 1066 — labels it **Create year "…"** instead) and the action registry (**Toggle theme** light↔dark, **Focus mode** enter/exit, undo/redo, sign out). An empty query instead shows **Recent** (synced per-user across devices when online — device-local fallback; the favorites/recents model is [feature-status.md](../feature-status.md)'s) and a refreshable **Random** five. The sidebar's search button (and the top bar's, when the sidebar is collapsed) opens the same palette.

Full-text search ranks by priority: pages whose **title literally contains** the query first, then blocks containing it, then pages/blocks carrying all the words in order (not necessarily adjacent), then blocks under a page whose title matches, then partial matches (only some words) — so typing `gmi dental` surfaces **GMI Dental Implantology** ahead of any page that merely mentions both words. Two query modes sharpen it: wrap the whole query in quotes (`"gmi dental"`) for **exact-substring only**, or start it with a caret (`^gmi dental`) for **starts-with only**. Searching an alias surfaces the canonical page too. Diacritics never block a match — `peru` finds "Perú". And when no title or text matches exactly, a fuzzy pass still rescues the query as an ordered letter subsequence (`gmi dntl` finds **GMI Dental Implantology**), ranked below every exact and prefix match. A property row opens the property's inspector (metadata, bound classes, every node carrying a value); it also answers type keywords ("date", "select"). Date pages answer formatted keywords ("feb 14") and the compact `YYYYMMDD` form, and the **`is_daily:`** prefix scopes the whole palette to date pages.

**`/` opens the filters.** A slash as the first character swaps the results for
a **Filters** option list — Daily pages, Pages, Blocks, Classes, With class…, and
(in the palette only) **Commands** — narrowed by whatever follows the slash, and
classes the slash text names surface directly (`/fic` offers "Class: Fiction";
the bare "With class…" row browses the whole class list). Picking an option turns
it into a removable **chip** under the search field that scopes the results:
Commands shows only the action registry, Classes only the class section, Daily
pages only the Date Pages section, Pages and Blocks restrict the page and
content hits to document-chrome nodes and inline blocks respectively, and a
With-class chip restricts every node section to that class's members (under it
the palette's typed **Create page "…"** row stays hidden — the palette's create
has no class path). Chips compose (AND), stack with the `is_daily:` prefix, and
ride until removed — **Backspace on an empty query pops the last chip**, and
each chip carries its own ×. The node pickers answer the same slash (see
[links.md](links.md)): the same kinds minus Commands, and a With-class chip
there behaves exactly like a `class:` refine — down to the created node landing
inside the class.

A non-empty query also offers a **Search all for "…"** row opening the full-page search (same as **Ctrl/Cmd+Shift+F**): the ranked results with snippets, scope tabs (All/Main/Blocks), and a class filter, paginated until exhausted ("Load more results" — the pagination convention is [views.md](views.md#long-lists--one-pagination-convention)).

## In-page find

**Cmd/Ctrl+F** on a page searches the whole block tree (collapsed blocks included, the data is the haystack) with a match counter, next/previous cycling, case and whole-word toggles, and replace inside text blocks.

## Global chords

Every global chord yields to text fields (while a text field or the outliner editor owns the focus, the keystroke stays text-scoped):

- **Ctrl/Cmd+N** — new page (created and opened)
- **Ctrl/Cmd+,** — the full settings page (deep-linkable at `/settings/<section>`, opening at Appearance — the quick-tweaks modal retired)
- **Ctrl/Cmd+\\** — toggle the sidebar
- **Alt+←/→** — Back/Forward through the pages you opened
- **Ctrl/Cmd+Shift+T** — today's page ([calendar.md](calendar.md))
- **Ctrl/Cmd+Shift+N** — quick add ([calendar.md](calendar.md#quick-capture))
- **Ctrl/Cmd+Alt+Enter** — present the open page ([pages.md](pages.md#presentation-mode--the-note-is-the-deck))
- **Ctrl/Cmd+Alt+F** — focus mode ([pages.md](pages.md#focus-mode))
- **Ctrl/Cmd+K** — this palette · **Ctrl/Cmd+Shift+F** — full-page search · **Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (or Ctrl+Y)** — undo/redo ([undo.md](undo.md)) · **Ctrl/Cmd+Shift+H** — the history menu ([undo.md](undo.md))

Over a text selection, **Ctrl/Cmd+L** opens the `@` picker with the selection prefilled as the search query (the pick replaces the selection — the "@ with a selection" gesture, under a "Replacing selection with link" banner), and **Ctrl/Cmd+Shift+L** opens it with an empty query that keeps the selection as the inserted link's custom label ('Link with custom label "…"' banner) — the picker contracts are [links.md](links.md)'s and the gestures ride the outliner's selection rules ([outliner.md](outliner.md)).
