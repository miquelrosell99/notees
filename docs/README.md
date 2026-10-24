# Notees documentation

Documentation for people — using the app, and developing or operating it. One page per feature, grouped by area; nothing here tracks implementation progress (that record lives in the repo's internal plan), but [feature-status.md](feature-status.md) labels every feature Today vs Designed.

## Getting started

- **[Getting started](getting-started.md)** — prerequisites, install, running the server, and the account boot.
- **[The Notees CLI](cli.md)** — configure the CLI, one real end-to-end session, and the scripting shell.
- **[Notees philosophy](philosophy.md)** — the ideas under the product, stated plainly.

## Core concepts

- **[Pages and blocks](features/pages.md)** — the two structural roles of one kind of node, view resolution, and page chrome.
- **[Classes](features/classes.md)** — classes are nodes: the class view, creating classes, workspace feature toggles.

## Features

**Content & editing**

- **[Outliner](features/outliner.md)** — the editor contract: gestures, slash commands, collapse, multi-select, drag reorder, the condensed layer.
- **[Links, mentions, and references](features/links.md)** — mention pills, class chips, typed-link marks, embeds, aliases, backlinks and unlinked mentions.
- **[Properties](features/properties.md)** — the Properties panel, value cells and their contracts, inline property buttons.
- **[Templates](features/templates.md)** — class-bound reusable bodies, the gallery, variables.
- **[Tables](features/tables.md)** — cells are nodes; the grid is a view.
- **[Whiteboards](features/whiteboards.md)** — the spatial canvas; cards are blocks.
- **[Pages](features/pages.md)** — also home to presenting a page, focus mode, promotion/demotion, copying, dividing, and merging.

**Organization & discovery**

- **[Queries](features/queries.md)** — query blocks, saved views, the structured-filters panel.
- **[Views and collections](features/views.md)** — list/cards/board, the sort button, pagination, custom views as tabs.
- **[Search and the command palette](features/search.md)** — ranking, query modes, in-page find, the global chords.
- **[Classes](features/classes.md)** — the class view and classed-nodes collection.
- **[The graph view](features/graph.md)** — the workspace as a map: families, layouts, colors, time lapse.

**Time & tasks**

- **[Calendar and day pages](features/calendar.md)** — the grid calendar and day agenda, day pages, recurrence, quick capture.
- **[Tasks](features/tasks.md)** — the Tasks hub's buckets and the checkbox semantics.

**Output**

- **[Exporting](features/exporting.md)** — Markdown/HTML/Word/LaTeX/PDF/JSON archive, table CSV/xlsx and import, workspace zips.
- **[Sharing](features/sharing.md)** — read-only public links, the Shares hub.
- **Presenting** — the note is the deck: [features/pages.md](features/pages.md#presentation-mode--the-note-is-the-deck).

**Power & automation**

- **[Workflows](features/workflows.md)** — when X on nodes matching Y, do Z — server-side automation.
- **[Plugins](features/plugins.md)** — the (honest, inert) plugin registry.
- **[Undo and redo](features/undo.md)** — the session journal.
- **[Offline work and sync](features/offline-and-sync.md)** — the backend-down ladder, the sync dot, settings → Sync.

## Reference

- **[Object API quick reference](api.md)** — every endpoint, auth, idempotency, scoped keys.
- **[The Notees CLI](cli.md)** — commands, exit codes, the shell.
- **[Feature status](feature-status.md)** — every feature labeled Today vs Designed.
- **[developers/](developers/)** — the runbooks for people developing or operating a Notees server (architecture, hacking, deployment, migrations, releases). Start from [developers/README.md](developers/README.md).
- **[packages/protocol/SCHEMA.md](../packages/protocol/SCHEMA.md)** — the normative model and wire spec the docs summarize.
