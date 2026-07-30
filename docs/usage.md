# Usage

Notees is a block-based, local-first note-taking app. Your workspace data lives in a client-side SQLite database inside the browser; edits happen instantly and sync to the server when you are online.

---

## Pages and blocks

- A **page** is a top-level note.
- A **block** is a child unit inside a page or inside another block.
- Every page and block is a single polymorphic `node` in the underlying data model.
- Blocks can be nested, moved, referenced, and embedded.

The outliner-style editor lets you fold, expand, and reorder blocks. Each block has its own UUIDv7 identifier and can be referenced independently.

---

## Bidirectional links

Create links between notes with wiki-style syntax:

```markdown
See [[Another page]] for details.
```

You can also insert `node_link` inline pills that reference a specific node. Notees parses these references automatically and maintains an `edge` table so backlinks are tracked in both directions.

When you open a page, a **Linked references** section shows pages and blocks that mention it. The count badge is always visible; the full list is loaded only when you expand the section to keep large pages fast.

---

## Daily journal

Notees provides built-in daily, monthly, and yearly journal pages with calendar navigation. The daily page can be opened from the sidebar or created on demand for any date.

---

## Tasks

Tasks can be created inline inside pages or as dedicated task pages with status, priority, and due dates. The web app includes a top-bar **Tasks** popup that groups tasks by:

- Overdue
- Today
- Upcoming
- Unscheduled

The mobile app provides a dedicated **Tasks** tab.

---

## Types, properties, and queries

- **Classes** (types) group nodes and can inherit from each other.
- **Property schemas** define typed fields such as text, number, date, select, or relation.
- Assign classes to pages or blocks and fill in property values to organize your knowledge base.

**Queries** use the visual QueryAST builder to filter and sort nodes by class, property, text, links, or tasks. Results can be viewed as:

- Lists
- Tables
- Kanban boards
- Calendars
- Timelines / Gantt

You can run a temporary ad-hoc query or save it as a persistent view inside a page.

---

## Graph view and whiteboard

- **Graph view** renders the workspace as an interactive network of pages and references.
- **Whiteboard** provides an infinite canvas for sketches and spatial layouts. Whiteboard state round-trips through the operation-log relay.

---

## Flashcards

Create and study cloze-deletion flashcards. Assigning the `card` class auto-creates flashcard rows; the front and back text are rehydrated from the node name and cloze children.

---

## Export

Pages and subtrees can be exported from the web app to:

- **Markdown**
- **HTML**
- **PDF**
- **OPML** (built-in plugin `notees.opml_exporter`)

The built-in OPML exporter converts node trees to OPML 2.0.

---

## Favorites, recents, and navigation

- **Favorites**: pin pages for quick access.
- **Recents**: quickly reopen recently viewed pages.
- **Search**: full-text search runs against the local SQLite `search_index` table, so it works offline. See [SEARCH.md](SEARCH.md) for implementation details.

---

## Multi-workspace

Notees supports multiple workspaces. Each workspace is an isolated knowledge base with its own operation log, derived SQLite database, and members. Switch workspaces from the workspace switcher in the top bar.

---

## Web vs mobile app

The Flutter mobile app is a first-class native companion. It covers the workflows most useful on phones, while the web app remains the full-featured desktop editing surface. The mobile app lives in its own repository: [miquelrosell99/notees-flutter](https://github.com/miquelrosell99/notees-flutter).

| Feature | Web app | Mobile app |
|---------|:-------:|:----------:|
| Page editing | ✅ | ✅ (plain-text blocks) |
| Block-based / outliner editing | ✅ | ❌ |
| Rich inline formatting | ✅ | ❌ |
| Bidirectional `[[links]]` | ✅ | ✅ (rendered as text, still parsed on save) |
| Daily journal | ✅ | ✅ |
| Task lists | ✅ (top-bar popup) | ✅ (dedicated Tasks tab) |
| Search with filters | ✅ | ✅ |
| Favorites | ✅ | ✅ |
| Recents | ✅ | ✅ |
| List / card / table views | ✅ | ✅ |
| Properties & types | ✅ | ❌ |
| Queries / database views | ✅ | ❌ |
| Whiteboard | ✅ | ❌ |
| Graph view | ✅ | ❌ |
| Timeline / Gantt / Calendar views | ✅ | ❌ |
| Export (Markdown, HTML, PDF, OPML) | ✅ | ❌ |
| Offline-first | ✅ | ✅ (native UI + quick capture) |
| Biometric app lock | ❌ | ✅ |
| Multi-server management | ❌ | ✅ |
| Native quick capture | ❌ | ✅ |

---

## Offline use

Because the workspace is stored locally, most actions work without a network connection:

- Read, create, edit, and delete pages and blocks
- Search
- View linked references
- Run queries

Sync resumes automatically when the browser reconnects. Pending local operations are stored in `sync_outbox` and retried with exponential backoff.
