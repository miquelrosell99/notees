# Notees Data Structure Audit vs. Rival Note Apps

**Date:** 2026-07-17
**Scope:** Audit of Notees' current data structure compared to rival note-taking apps, plus a recommended architecture if Notees were built from scratch today.
**Status:** Working document for continued discussion.

---

## Part 1 — Notees Data Model Today

Notees uses a **single-table polymorphic node store** in PostgreSQL.

| Concept | Implementation |
|---|---|
| Core atom | `node` table (pages, blocks, tags, properties, classes, journals, tasks, templates, comments, assets) |
| Differentiation | Boolean flags (`is_page`, `is_task`, `is_class`, `is_daily`, …) + `class_ids`/`tag_ids` integer arrays |
| Hierarchy | Adjacency list via `parent_id` and `page_id`; breadcrumbs/ancestors via recursive CTEs |
| Content | JSON AST stored in `node.name` (pages store title AST, blocks store content AST) |
| Links | `node_link` table for `[[Page]]` / `((block-uuid))` references, inline class refs, and embeds |
| Properties | EAV-style: `property` schema + `node_property` assignment + `property_value_scalar/relation/selection` |
| Classes | Special `node` rows with `is_class = true`, plus `class_property` and `class_extend` for inheritance |
| Queries | QueryAST stored as JSONB in `node_view.query_json`, compiled to SQL at runtime |
| Sync/offline | `node_revision` version vectors, `node_yjs_state` for CRDT text state, offline-first React runtime |
| History/undo | `node_version` snapshots + `undo_log` with before/after JSONB states |
| Assets | Content-addressed by hash in the `asset` table |

Key sources: `agents/data-model.md`, `app/db/schema/sql.py`, `app/domain/entities/query_ast.py`, `app/domain/entities/content.py`, `frontend/src/types/ast.ts`.

---

## Part 2 — Comparative Audit

### 2.1 Core Atom

| App | Core Atom | Notes |
|---|---|---|
| **Notees** | Polymorphic `node` | One table for everything; flags + class arrays differentiate semantics. |
| **Notion** | Block | Everything is a block (page, paragraph, DB row, image). Each block has `id`, `type`, `properties`, `content`, `parent`. |
| **Obsidian** | Markdown file | Plain-text `.md` files with YAML frontmatter; attachments are separate files. |
| **Logseq** | Outline bullet / block | Local Markdown/Org-mode files; bullets are blocks with stable IDs; graph DB version in development. |
| **Roam Research** | Node (page or block) | Hypergraph: pages and blocks are nodes; relationships are first-class nodes. |
| **Anytype** | Object | Object = typed entity; Type defines schema; Relations are typed links; Sets/Collections are filtered views. |
| **Capacities** | Object | Similar to Anytype: typed objects with custom properties and bidirectional links. |
| **AppFlowy / AFFiNE** | Block | Notion-like block trees; AppFlowy (Rust+Flutter), AFFiNE (TS+Rust+CRDTs, doc+whiteboard hybrid). |

**Verdict:** Notees sits between Notion's block atom and Anytype/Capacities' object atom. The polymorphic `node` table gives flexibility but risks boolean-flag sprawl and overloaded `name` semantics.

### 2.2 Hierarchy & Nesting

| App | Model | Strengths / Risks |
|---|---|---|
| **Notees** | Adjacency list (`parent_id`/`page_id`) + recursive CTEs | Simple, index-friendly, supports soft-delete cascading. Deep trees can be expensive without materialized paths. |
| **Notion** | Render tree with bidirectional `content` (down) and `parent` (up) pointers | Efficient permission traversal up; flexible block reuse across content arrays. More complex consistency surface. |
| **Obsidian** | File-system folders + Markdown headings | Trivial to understand and version-control; weak block-level addressing. |
| **Logseq** | Outline indentation + block refs | Natural outliner nesting; block-level transclusion; file-based limits on deep structure. |
| **Roam Research** | Hypergraph — no rigid tree, blocks can appear in many contexts via refs | Extremely flexible; complex garbage-collection and provenance tracking. |
| **Anytype** | Object graph + Sets/Collections | No folder hierarchy by default; graph queries replace tree navigation. |
| **Capacities** | Object graph with "Webbing" links | Networked; no traditional folders. |
| **AppFlowy / AFFiNE** | Block tree (Notion-like) | Same trade-offs as Notion. |

**Verdict:** Notees' adjacency-list model is the conventional, proven choice for relational backends. It lacks Notion's elegant bidirectional tree pointers and Roam's hypergraph freedom, but it is simpler to query, index, and reason about for self-hosters.

### 2.3 Linking & Backlinks

| App | Mechanism |
|---|---|
| **Notees** | `node_link` table materializes `[[Page]]` / `((block-uuid))` / inline-class / embed references; `node_mention` tracks unlinked mentions. |
| **Notion** | Page mentions and synced blocks; backlinks surfaced via search/index rather than a separate link table. |
| **Obsidian** | Parses wiki-links `[[...]]` and Markdown links from plain text at runtime; maintains a metadata cache. |
| **Logseq** | Bidirectional `[[...]]` and block `((...))` refs; link graph rebuilt from plain text. |
| **Roam Research** | `[[...]]` / `((...))` create edges in the hypergraph; attributes (`Name:: value`) add typed edges. |
| **Anytype** | Relations are typed, often bidirectional; object graph is first-class. |
| **Capacities** | Bidirectional object links and "two-way linking of properties." |
| **AppFlowy / AFFiNE** | Mention/link systems similar to Notion. |

**Verdict:** Notees' materialized `node_link` table is a strength: backlinks are queryable in SQL without re-parsing text, and typed columns support rich semantics. The cost is keeping `node_link` in sync with the AST.

### 2.4 Properties & Schema

| App | Model |
|---|---|
| **Notees** | EAV with typed value tables (scalar, relation, selection); class-property defaults; property scope (global/class/node). |
| **Notion** | Each database block has a schema of properties; pages can have page-level properties. Properties are tightly coupled to DB views. |
| **Obsidian** | YAML frontmatter (untyped/loosely typed); Dataview plugin adds query layer. |
| **Logseq** | Page/block properties via `key:: value`; attribute queries with Datalog. |
| **Roam Research** | `Name:: value` attributes compiled into typed triples `[e a v]`; attribute names are pages. |
| **Anytype** | Strong object types with defined Relations; Types inherit; Sets are filtered collections. |
| **Capacities** | Custom object types with properties; property types include relations, dates, checkboxes, labels. |
| **AppFlowy / AFFiNE** | Notion-like database fields / board/calendar views. |

**Verdict:** Notees' EAV design is powerful and normalized, but EAV always makes complex queries harder to optimize. Anytype and Capacities offer a cleaner typed-object UX because "type" is first-class rather than a class node + boolean flags.

### 2.5 Query Model

| App | Query Approach |
|---|---|
| **Notees** | QueryAST → SQL compiler at runtime; JSONB stored in `node_view.query_json`; supports table/kanban/calendar/gantt/graph/timeline views. |
| **Notion** | Filter/sort UI backed by server-side query engine; no user-facing query language. |
| **Obsidian** | Search + Dataview plugin (DQL) over metadata cache. |
| **Logseq** | Datalog queries over graph; advanced queries for power users. |
| **Roam Research** | Datalog queries over Datascript EAV index. |
| **Anytype** | Sets (filtered views) over object types/relations; graph navigation. |
| **Capacities** | Queries over object types and properties; AI-assisted search. |
| **AppFlowy / AFFiNE** | Database views with filters/sorts (Notion-style). |

**Verdict:** Notees' QueryAST-to-SQL compiler is a genuine differentiator for a self-hosted app. The risk is the maintenance surface of safely compiling every new condition type.

### 2.6 Storage & Sync Model

| App | Storage | Sync |
|---|---|---|
| **Notees** | PostgreSQL backend + local SQLite (sql.js) in browser + outbox/optimistic sync | Version vectors (`node_revision`) + Yjs CRDT state (`node_yjs_state`) |
| **Notion** | Cloud-hosted, source-of-truth DB | Operational transformations / records + WebSocket real-time |
| **Obsidian** | Local Markdown files | Optional Obsidian Sync (paid) or any file sync |
| **Logseq** | Local Markdown/Org files | Optional Logseq Sync or file sync; DB version in development |
| **Roam Research** | Cloud-hosted Datascript graph | Real-time collaborative graph |
| **Anytype** | Local objects; IPFS/Any-Sync | P2P encrypted sync, optional An-Node backup |
| **Capacities** | Cloud + local apps | Proprietary sync |
| **AppFlowy / AFFiNE** | Self-hostable cloud (PostgreSQL/Redis/MinIO) or local | AppFlowy Cloud, CRDTs for AFFiNE |

**Verdict:** Notees is one of the few apps combining structured PostgreSQL backend with offline-first client state and CRDT text. Obsidian/Logseq win on portability; Anytype wins on decentralization.

### 2.7 Content Representation

| App | Format |
|---|---|
| **Notees** | Rich JSON AST in `node.name`; Markdown is derived/lossy; supports inline node links, date ranges, math, embeds, query blocks, whiteboards. |
| **Notion** | Block records with properties; no canonical plain-text export; Markdown export is lossy. |
| **Obsidian** | Markdown is source of truth; minimal lock-in, limited rich structure. |
| **Logseq** | Markdown/Org outline; plain text first; block properties add structure. |
| **Roam Research** | Outliner blocks; EAV attributes; export options available. |
| **Anytype** | Object editor with blocks; proprietary object format underneath. |
| **Capacities** | Object-based editor; proprietary format. |
| **AppFlowy / AFFiNE** | Block-based, similar to Notion. |

**Verdict:** Notees' AST-centric approach matches Notion more than Obsidian. The explicit `schema_version` and migration helpers show maturity, but portability is weaker than file-based rivals.

---

## Part 3 — Strengths of Notees' Current Design

1. **Unified polymorphic node table** — pages, blocks, tasks, tags, classes, and properties share one storage model.
2. **Materialized link graph** — `node_link` enables fast SQL backlink/graph queries.
3. **QueryAST → SQL compiler** — unusual for a self-hosted note app; enables rich filtered views.
4. **Typed property EAV** — scalar/relation/selection value tables give real type safety for filters.
5. **Offline-first + CRDT text** — `node_revision` vectors plus `node_yjs_state` support optimistic sync.
6. **History and undo as first-class tables** — `node_version`, `undo_log`, and soft-delete are built-in.
7. **Content-addressed assets** — `asset` table deduplicates files by hash per workspace.

---

## Part 4 — Weaknesses / Risks vs. Rivals

1. **Boolean-flag polymorphism** — adding new node kinds requires schema changes and risks combinatorial misuse.
2. **Overloaded `name` column** — pages use it for title AST, blocks for content AST.
3. **EAV query complexity** — rich property queries require multiple joins; performance can degrade at scale.
4. **AST ↔ link consistency** — every edit that changes `[[...]]` references must sync AST and `node_link`.
5. **Portability gap** — data is not plain Markdown; export/import fidelity depends on AST round-tripping.
6. **No true hypergraph** — links are edges between nodes, not addressable relationships with metadata.
7. **Class system complexity** — classes-as-nodes with `class_extend` inheritance is powerful but harder to expose than Notion's "database" or Anytype's "type."

---

## Part 5 — Recommended Architecture from Scratch

### 5.1 Core Philosophy: Operations Are the Source of Truth

Replace mutable rows with an **immutable operation log**. Every user action is one operation:

```json
{
  "op": "block.insert",
  "id": "op_uuidv7",
  "actor": "user_uuid",
  "timestamp": "2026-07-17T10:53:54Z",
  "clock": { "deviceA": 42, "deviceB": 17 },
  "payload": {
    "block_id": "blk_uuidv7",
    "parent_id": "page_uuidv7",
    "index": 3,
    "content": { ...AST... }
  }
}
```

Operation types include:
- `block.insert`, `block.update`, `block.move`, `block.delete`
- `property.set`, `property.unset`
- `link.add`, `link.remove`, `link.set_meta`
- `class.assign`, `class.create`
- `workspace.create`, `share.grant`

This unifies sync (vector clocks), history (free), undo (inverse operations), and collaboration (CRDT ops).

### 5.2 Derived Document Model: Block Tree + Object Graph

From the operation log derive two views.

**A. Block Tree (for the editor)**

```ts
interface Block {
  id: string;           // UUIDv7
  type: "paragraph" | "heading" | "task" | "page" | "whiteboard" | ...;
  parentId: string | null;
  children: string[];   // ordered IDs
  content: AST;         // inline content, no embedded children
  properties: Record<string, PropertyValue>;
  classIds: string[];
  createdAt: string;
  modifiedAt: string;
}
```

Blocks can carry typed properties directly, unifying Notees' "page + property" and "block" concepts.

**B. Object Graph (for queries and relationships)**

```ts
interface Node {
  id: string;
  kind: "page" | "block" | "class" | "tag" | "task" | "property" | "asset";
  name: string;         // derived display text
}

interface Edge {
  id: string;
  sourceId: string;
  targetId: string;
  type: "mention" | "reference" | "embed" | "property" | "class-instance" | "tag";
  metadata?: Record<string, any>;
}
```

This powers backlinks, graph view, class queries, and filtered collections. Because it is derived, it can be rebuilt from the operation log.

### 5.3 Storage Architecture: SQLite Everywhere, Sync When Needed

**Local primary store: SQLite**

| Table | Purpose |
|---|---|
| `operations` | Immutable operation log, ordered by vector clock |
| `blocks` | Derived current block tree |
| `edges` | Derived link/property graph |
| `properties` | Property schemas and values |
| `classes` | Type/class definitions |
| `search_index` | FTS5 index over derived block text |
| `blobs` | Content-addressed attachments |

**Server role: sync + backup, not primary storage**

The server only:
1. Receives operation batches.
2. Validates permissions.
3. Stores operations durably.
4. Forwards operations to other clients.

If PostgreSQL is retained, the server schema can be minimal:

```sql
CREATE TABLE operations (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    vector_clock JSONB NOT NULL,
    op_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_operations_workspace_clock ON operations (workspace_id, vector_clock);
```

### 5.4 Sync: CRDT Operations, Not Optimistic Patches

Use **operation-based CRDTs**:
- Operations designed to be commutative/associative/idempotent where possible.
- Ordered lists use a CRDT sequence type (RGA/LSEQ/YATA) or Yjs' `Y.Array`/`Y.XmlFragment`.
- Property values use LWW-register or multi-value register CRDTs.

This replaces Notees' three separate mechanisms (`node_revision`, `node_yjs_state`, `undo_log`) with one unified model.

### 5.5 Properties & Classes: Schema-on-Read, Not EAV

Avoid the EAV table explosion. Define classes and store properties inline on blocks:

```ts
interface Class {
  id: string;
  name: string;
  extends: string[];           // class inheritance
  properties: PropertySchema[];
}

interface PropertySchema {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "select" | "multi_select" | "node" | "checkbox";
  config: Record<string, any>;
}

interface Block {
  ...
  properties: Record<string, PropertyValue>;
}
```

Use SQLite expression indexes for fast filtering:

```sql
CREATE INDEX idx_blocks_status ON blocks ((properties->>'status'))
WHERE classIds @> '["class-status-tracked"]';
```

### 5.6 Markdown: First-Class Interchange, Not Source of Truth

Make Markdown **losslessly round-trippable** but not canonical. Use a strict dialect:

```markdown
---
class: project
status: active
due: 2026-08-01
---

# Project Apollo

Owner:: [[Jane Doe]]
Tags:: [[urgent]] [[backend]]

- [ ] Design data model #task #backend
  - Block reference: ((block-uuid))
```

On import, parse into operations. On export, render derived state. This closes the portability gap versus Obsidian/Logseq without sacrificing structure.

### 5.7 Query Model: Keep QueryAST, Retarget to SQLite

Notees' QueryAST → SQL compiler remains a good idea. Retarget it to compile against derived SQLite `blocks`/`edges`/`properties` tables.

Example compiled query:

```sql
SELECT b.id, b.content
FROM blocks b
WHERE b.workspaceId = ?
  AND b.classIds @> '["class-project"]'
  AND b.properties->>'status' = 'active'
  AND EXISTS (
    SELECT 1 FROM edges e
    WHERE e.sourceId = b.id AND e.type = 'tag' AND e.targetId = ?
  );
```

### 5.8 Recommended Stack Summary

| Layer | Recommendation |
|---|---|
| **Source of truth** | Immutable operation log with vector clocks |
| **Conflict resolution** | Operation-based CRDTs (Yjs-style or custom) |
| **Local storage** | SQLite (sql.js/OPFS on web, native on desktop/mobile) |
| **Derived state** | Block tree + object graph + FTS index rebuilt from log |
| **Server** | Thin sync/backup service storing operations |
| **Content model** | Blocks with inline typed properties + class inheritance |
| **Links** | Hypergraph edges (relationships can carry metadata) |
| **Interchange** | Strict Markdown dialect with YAML frontmatter and block properties |
| **Queries** | QueryAST compiled to SQLite SQL |

---

## Part 6 — One-Sentence Takeaway

> Start with an **immutable, local-first operation log** as the single source of truth; derive a **typed block tree + hypergraph** in SQLite for editing and querying; and treat **Markdown as a guaranteed round-trip interchange format** — this gives Notees the self-hosting portability of Obsidian, the structural power of Anytype, and the block editing fluidity of Notion, without the schema complexity of its current PostgreSQL design.

---

## Part 7 — Open Questions for Continued Discussion

1. Should Notees migrate incrementally toward this model, or is a clean rewrite ever realistic?
2. How important is real-time collaborative editing versus offline-first single-player?
3. Should the server remain PostgreSQL-based, or is a purpose-built sync server (e.g., SQLite on server, operation log) preferable?
4. How much plain-text portability is required to compete with Obsidian/Logseq?
5. Should relationships themselves be editable/annotatable (true hypergraph) or remain simple edges?
6. What is the migration path for existing user data if the schema changes this radically?

---

## Part 8 — Comparison with Logseq DB Version

### What Logseq DB Version Is

Logseq's database version is a re-architecture of the file-based (Markdown) graph. Public sources and team posts describe it as:

- A **forked Datascript** (immutable in-memory Datalog database) with persistent storage support.
- Underlying persistence via **SQLite** (sqlite-wasm on web, native SQLite on desktop/mobile).
- The same conceptual data model as the Markdown version — blocks, pages, properties, links — but stored as a graph of Datascript entities instead of plain text files.
- Graph data physically stored as **key-value pairs** (`id → serialized node in a tree`) inside SQLite.
- A **Datalog query interface** for advanced queries.
- Real-time collaboration (RTC) developed in parallel, with end-to-end encryption.
- Custom merge logic rather than CRDTs — the team explicitly explored CRDTs and decided existing solutions did not fit their needs.
- Long-term goal: maintain Markdown file support and achieve two-way sync between the DB graph and Markdown files.

Sources: [Logseq forum post on the DB version](https://discuss.logseq.com/t/why-the-database-version-and-how-its-going/26744), community summaries of the architecture.

---

### 8.1 High-Level Similarities

| Aspect | Logseq DB Version | Recommended Notees Design |
|---|---|---|
| **Local-first** | Yes — data lives locally in SQLite | Yes — SQLite is the local primary store |
| **Markdown no longer canonical** | DB is canonical; Markdown is a target for sync/export | Operation log is canonical; Markdown is a round-trip interchange format |
| **Structured properties/classes** | First-class classes and properties | Blocks carry typed properties; classes define schemas |
| **Graph queries** | Datalog | QueryAST → SQL |
| **Sync** | Custom RTC merge (not CRDT-based) | Operation-based CRDTs |
| **Web/Electron/Mobile** | Targeting all three | Same target via SQLite everywhere |

Both architectures reject the idea that plain Markdown files can be the source of truth for a rich, collaborative knowledge graph.

---

### 8.2 Key Differences

#### A. Source of Truth Shape

| Logseq DB Version | Recommended Notees Design |
|---|---|
| Datascript entity graph persisted as serialized nodes in SQLite. | Immutable operation log; block tree and object graph are derived views. |

**Implication:** Logseq's model is simpler to reason about because the Datascript graph *is* the application state. The recommended Notees model adds a layer of indirection (operation log → derived state) but gains perfect history, reproducibility, and simpler sync/undo semantics.

#### B. Query Language

| Logseq DB Version | Recommended Notees Design |
|---|---|
| Datalog (native to Datascript). | QueryAST compiled to SQL against derived SQLite tables. |

**Implication:** Datalog is more expressive for graph traversal and recursive queries. SQL is more familiar to most engineers, easier to optimize with standard indexes, and maps directly to the block/property tables. Notees already has QueryAST → SQL; retargeting it to SQLite is straightforward.

#### C. Conflict Resolution / Sync

| Logseq DB Version | Recommended Notees Design |
|---|---|
| Custom RTC merge logic; CRDTs were explored and rejected. | Operation-based CRDTs as the default conflict-resolution mechanism. |

**Implication:** Logseq's approach may be tuned precisely to their data model, but it requires inventing and proving correctness for merge behavior. CRDTs are a well-studied foundation; the main cost is designing operations that are commutative/associative/idempotent where needed. For Notees, which already uses Yjs (`node_yjs_state`), leaning into CRDTs is more consistent than abandoning them.

#### D. Storage Layout

| Logseq DB Version | Recommended Notees Design |
|---|---|
| Key-value: `id → serialized node` in a tree. | Relational-ish derived tables: `operations`, `blocks`, `edges`, `properties`, `classes`, `search_index`. |

**Implication:** Logseq's serialized-node approach is compact and matches Datascript's entity model, but it may limit direct SQL queryability and make full-text search/indexing a separate concern. The recommended Notees design keeps data in normalized/queryable SQLite tables, making it easier to inspect, migrate, and index.

#### E. History and Undo

| Logseq DB Version | Recommended Notees Design |
|---|---|
| Datascript transactions provide history; explicit undo/redo built on top. | Every operation is immutable; undo inserts an inverse operation; full history is free. |

**Implication:** Both can support undo/redo and history. The operation-log model makes branching, offline replay, and audit trails more natural.

#### F. Markdown Interop

| Logseq DB Version | Recommended Notees Design |
|---|---|
| Aims for two-way sync between DB graph and Markdown files. | Markdown is import/export/backup format, not a live sync target. |

**Implication:** Logseq is trying to preserve its existing Markdown-first user base and plugin ecosystem. That two-way sync is technically hard because Markdown is lossy and file-level changes are coarse. The recommended Notees design sidesteps that complexity by treating Markdown as a guaranteed round-trip format, not a continuously synchronized backend.

---

### 8.3 When Logseq DB Version Is Stronger

1. **Datalog expressiveness** — recursive graph queries and pattern matching are more natural in Datalog than in SQL.
2. **Single state model** — no separate operation log and derived views to keep consistent.
3. **Existing ecosystem** — same conceptual model as the Markdown version, so user mental models and plugins transfer more easily.
4. **Proven immutable DB foundation** — Datascript is battle-tested in Clojure/ClojureScript apps.

---

### 8.4 When the Recommended Notees Design Is Stronger

1. **Sync correctness** — operation-based CRDTs provide a clearer theoretical foundation than custom merge logic.
2. **SQL queryability** — derived tables are directly queryable with standard SQL, no Datalog runtime required.
3. **Portability to non-Clojure stacks** — Notees is Python/FastAPI + React/TypeScript; SQLite + SQL fits that stack naturally, whereas Datascript is tightly coupled to Clojure/ClojureScript.
4. **History and audit trails** — immutable operation log gives this for free.
5. **Server simplicity** — a thin sync server only needs to store and forward operations, not host a complex graph database.
6. **Migration from current Notees** — retargeting the existing QueryAST → SQL compiler to SQLite is easier than adopting Datalog.

---

### 8.5 Strategic Takeaway

Logseq DB version and the recommended Notees design are converging on the same high-level conclusion: **local SQLite storage, a structured graph model, and Markdown as a secondary/interchange format**. The main divergence is philosophical:

- **Logseq** keeps the graph as the primary abstraction and uses Datascript/Datalog because its roots, team, and ecosystem are in Clojure's immutable-data philosophy.
- **Recommended Notees** keeps the **operation log** as the primary abstraction and derives a SQL-queryable graph because its stack and existing architecture (QueryAST, PostgreSQL, FastAPI, React) are already relational/SQL-shaped.

For Notees specifically, the operation-log + SQLite-derived-views approach is a better fit than copying Logseq's Datascript model. It preserves Notees' existing investment in QueryAST/SQL, aligns with its Python/React stack, and provides a cleaner sync foundation. Notees could still borrow Logseq's user-facing concepts — block properties, class schemas, Datalog-style query UI — while keeping a SQL backend.

---

### 8.6 New Open Questions Added

7. Should Notees expose a Datalog-like query layer on top of SQLite for power users, even if the engine is SQL?
8. Does Logseq's rejection of CRDTs reveal a real practical limitation that Notees should consider before committing to operation-based CRDTs?
9. Should Notees support live two-way Markdown sync (like Logseq aims for) or stick to import/export?
10. How much should Notees emulate Logseq's block-property / class-property UX versus Anytype's object-type UX?

---

## Part 9 — Converged Ideal Design (Current State)

This section captures the design decisions reached through discussion. It is the working target architecture.

### 9.1 Non-Negotiable Priorities

1. **Offline-first & local performance** — the app must work without network; local storage is primary.
2. **Real-time collaboration** — multiple users must be able to edit the same workspace concurrently.
3. **Structured querying power** — rich databases, filtered views, graph queries, and knowledge-graph semantics.
4. **Self-hosted server** — sync/relay server is user-controlled, not a vendor cloud.

Plain-text portability was explicitly deprioritized as a live-sync requirement. Markdown is an interchange format, not a peer data source.

---

### 9.2 What Is a Node?

A **node** is the unit of content in the system.

```ts
interface Node {
  id: string;                 // UUIDv7
  workspaceId: string;
  kind: "page" | "block" | "class";
  classIds: string[];         // user-defined classes this node instantiates
  parentId: string | null;    // tree position
  children: string[];         // ordered child IDs
  content: InlineNode[];      // inline AST: text, refs, formatting, math, embeds
  properties: Record<string, PropertyValue>; // keyed by property schema ID
  createdAt: string;
  modifiedAt: string;
  createdBy: string;
}
```

### 9.3 System Kinds Are Minimal

Only three structural primitives are system-level kinds:

| Kind | Meaning |
|---|---|
| `page` | A node that renders as a document view. Its children are blocks. |
| `block` | A node inside a page or another block. |
| `class` | A node that defines a schema of properties and behavior. |

All other concepts — task, journal, tag, person, project, image, PDF — are **user-defined or built-in classes**.

A class node looks like:

```ts
{
  id: "project-class-id",
  kind: "class",
  name: "Project",
  propertySchemaIds: ["owner-schema-id", "status-schema-id", "due-schema-id"],
  extends: ["base-entity-class-id"]
}
```

A page node that is a Project looks like:

```ts
{
  id: "apollo-project-id",
  kind: "page",
  classIds: ["project-class-id"],
  content: [{ type: "heading", children: [{ type: "text", text: "Project Apollo" }] }],
  properties: {
    "owner-schema-id": { targetId: "jane-id", label: "Jane Doe" },
    "status-schema-id": { value: "active" },
    "due-schema-id": { value: "2026-08-01" }
  }
}
```

### 9.4 Non-Node Entities: Users, Workspaces, Property Schemas

Some entities are **not nodes** because they have different lifecycles and concerns.

#### Users and workspaces

These are relational, account-level entities:

```sql
"user" (id, uuid, email, password_hash, name, ...)
workspace (id, uuid, name, owner_id, ...)
membership (workspace_id, user_id, role)
```

They do not participate in the content graph. A user is not a page. A workspace is not a class.

#### Property schemas

Property schemas live in a dedicated table:

```sql
property_schema (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,        -- text, number, date, select, multi_select, node, checkbox, file
  computed JSONB,            -- null for stored properties; { kind, expression } for computed ones
  config JSONB NOT NULL,     -- options, relation class IDs, inverse property, formula
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

`type` is the scalar or structural type the property returns. `computed` is an optional computation strategy with `kind` (`formula`, `rollup`, `query`) and an `expression` in a restricted safe language. Reasons property schemas are not nodes:
- They require strict validation.
- They change rarely and globally.
- Querying class structure must be fast and reliable.
- Treating them as mutable nodes risks invalid schema definitions and bootstrapping regress.

### 9.5 References Are ID-Based, Not Name-Based

Every reference in the system — inline content link or property relation value — points to a node ID, not a name.

Inline link AST node:

```json
{
  "type": "ref",
  "targetId": "jane-node-id",
  "label": "Jane Doe",
  "refType": "node"
}
```

Property relation value:

```json
{
  "targetId": "jane-node-id",
  "label": "Jane Doe"
}
```

The user types `@` or `[[` and searches by name, but the stored reference is the UUID. Display labels are independent of target names, so:
- Duplicate names are allowed.
- Renaming a target updates rendered text everywhere.
- Changing a link's label does not rename the target.

### 9.6 Properties Are Selected, Not Written

Users do not type property syntax into content. Properties are assigned through UI controls:
- Dropdowns for select/multi-select.
- Date pickers for dates.
- Relation pickers for node references.
- Checkboxes for booleans.
- File uploaders for files.

Property values live inline on the node, keyed by property schema ID. The schema defines type, validation, options, inverse relations, and cardinality.

### 9.7 Assets Are Normal Class Instances

There is no `kind: "asset"` and no separate `asset` table. An image, PDF, or audio file is just a node of a class that has a `file` property.

```ts
// Image class
{
  id: "image-class-id",
  kind: "class",
  name: "Image",
  propertySchemaIds: ["file-schema-id", "alt-text-schema-id", "source-schema-id"]
}

// Image node embedded in a document
{
  id: "team-photo-node-id",
  kind: "block",
  classIds: ["image-class-id"],
  content: [{ type: "text", text: "Team photo 2026" }],
  properties: {
    "file-schema-id": {
      hash: "sha256...",
      size: 1024000,
      mimeType: "image/webp",
      originalName: "team-photo.webp",
      width: 1200,
      height: 800
    },
    "alt-text-schema-id": { value: "The team at the offsite" }
  }
}
```

Files are stored content-addressed by hash:

```
data/workspaces/{workspace_uuid}/blobs/{hash[0:2]}/{hash}
```

Upload flow:
1. Stream file to temp location.
2. Compute hash.
3. If hash exists, reuse the stored blob.
4. Move blob to final content-addressed path.
5. Create node with `file` property referencing the hash.

Garbage collection scans all nodes for referenced hashes and deletes unreferenced blobs.

The `file` property type is a system-handled property type. The renderer knows how to render a node of class `Image` because the class has a `file` property, not because there is an asset subsystem.

### 9.8 Source of Truth: Immutable Operation Log

Every mutation is an immutable operation:

```json
{
  "id": "op-uuidv7",
  "type": "node.create" | "node.update" | "node.move" | "node.delete" |
         "property.set" | "property.unset" |
         "class.assign" | "class.unassign",
  "actorId": "user-uuid",
  "workspaceId": "workspace-uuid",
  "hlc": { "physical": 1234567890, "logical": 5 },
  "affectedNodeIds": ["node-a", "node-b"],
  "payload": { ... },
  "timestamp": "2026-07-17T10:53:54Z"
}
```

The operation log is the source of truth. SQLite holds derived tables:

| Table | Derived from |
|---|---|
| `operations` | Source of truth |
| `snapshot` | Derived state checkpoints |
| `nodes` | Operation log |
| `node_child_order` | CRDT sequence positions |
| `property_value` | Property operations |
| `edges` | Content refs + property relation values |
| `search_index` | Node content |
| `blobs` | Content-addressed files on disk |

Benefits:
- Full history is free.
- Undo is inserting an inverse operation.
- Sync is replicating operations.
- Derived state can be rebuilt at any time.

### 9.9 Sync: Self-Hosted Operation Relay with CRDTs

The server is a thin relay:
- Stores an ordered operation log per workspace.
- Validates permissions.
- Forwards operations to connected clients.
- Provides catch-up sync for offline clients.

Conflict resolution uses operation-based CRDTs:
- Registers use last-writer-wins or multi-value registers.
- Ordered children use a CRDT sequence (YATA, RGA, or Yjs Array).
- Operations are encrypted end-to-end before reaching the server.

The server does not run queries, understand the data model, or hold the source of truth.

### 9.10 Query Model: QueryAST → SQL, Optional Datalog

The primary user-facing query language is QueryAST, compiled to SQLite SQL:

```sql
SELECT n.id, n.content
FROM nodes n
WHERE n.workspace_id = ?
  AND n.class_ids @> '["project-class-id"]'
  AND n.properties->>'status-schema-id' = 'active'
  AND EXISTS (
    SELECT 1 FROM edges e
    WHERE e.source_id = n.id AND e.type = 'tag' AND e.target_id = ?
  );
```

For power users and agents, expose a read-only Datalog interface over the same derived tables.

### 9.11 Markdown: Round-Trip Interchange Only

Markdown is not a live data source. It is used for:
- Export/backup.
- Import from other tools.
- Interoperability.

A strict Markdown dialect preserves ID-based references:

```markdown
---
class: project
status: active
owner: [[jane-node-uuid|Jane Doe]]
due: 2026-08-01
---

# Project Apollo

This project is led by [[jane-node-uuid|Jane Doe]] since 2024.

- [ ] Design data model #task
```

On import, IDs resolve or create stubs. On export, IDs are preserved with display labels. Two-way live Markdown sync is intentionally out of scope because it conflicts with the structured graph model.

### 9.12 Why This Is Not Notees Today

| Notees Today | Converged Ideal Design |
|---|---|
| PostgreSQL server is source of truth | Local SQLite + operation log is source of truth |
| Mutable `node` rows | Immutable operations derive state |
| Boolean flags (`is_page`, `is_task`, …) | Three system kinds: `page`, `block`, `class` |
| `node.name` overloaded for title/content | `content` is always AST; `kind` disambiguates |
| Links parsed from `[[name]]` AST | Links are ID-based refs with labels |
| EAV property tables | Properties inline on nodes; schemas in dedicated table |
| `asset` table and `kind: "asset"` | Assets are normal class instances with `file` property |
| `node_yjs_state` + `node_revision` + `undo_log` | One operation log replaces all three |
| Server runs queries | Server is a sync relay; client runs queries |
| Markdown-ish as live model | Markdown is interchange only |

### 9.13 Open Risks

1. **CRDTs for rich block trees are hard.** Yjs exists, but mapping its model to a classed-node graph is non-trivial.
2. **SQLite on web is maturing.** OPFS + sqlite-wasm is good but not as battle-tested as native SQLite.
3. **Datalog-on-SQLite is extra work.** Either implement a Datalog compiler or embed a query runtime.
4. **Users expect `[[...]]` linking.** The `@`-and-select model is better but requires retraining.
5. **File garbage collection must be correct.** Deleting a node must eventually delete unreferenced blobs, but not too aggressively.

### 9.14 Current Open Questions

11. Should the operation log be exposed to users/agents directly, or only through derived views?
12. Should class inheritance be single or multiple?
13. Should the `file` property type support multiple files (gallery) natively, or only via class-level multi-relations?
14. How should the system handle renaming a property schema across all existing nodes?
15. Should there be a built-in set of core classes (Task, Person, Project, Journal), or should the app ship with a blank slate and templates?

---

## Part 10 — Design Updates

This section records decisions made after the initial converged design was written.

### 10.1 Property Values Move to a Dedicated Table

Property values are no longer stored inline on the node as JSONB. They live in a dedicated table:

```sql
property_value (
  id UUID PRIMARY KEY,
  node_id UUID NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  property_schema_id UUID NOT NULL REFERENCES property_schema(id) ON DELETE CASCADE,
  value JSONB NOT NULL,
  index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_property_value_single
ON property_value(node_id, property_schema_id)
WHERE index = 0;
```

#### Rationale

A separate table is better than inline JSONB because:

- **Queryability:** filtering by property value becomes a direct indexed query instead of a JSONB expression scan.
- **Referential integrity:** `node_id` and `property_schema_id` are foreign keys.
- **Cardinality enforcement:** single-valued properties use a partial unique index; multi-valued properties use multiple rows with increasing `index`.
- **Indexability:** covering indexes on `(property_schema_id, value)` are easy to add.

#### In-memory representation

At the application layer, a node is still assembled with a `properties` map:

```ts
node.properties = {
  "owner-schema-id": { targetId: "jane-node-id", label: "Jane Doe" },
  "status-schema-id": { value: "active" }
}
```

The repository joins `node` with `property_value` to build this map. Storage is relational; the API is document-oriented.

#### Why this is not Notees' EAV

Notees has separate `property_value_scalar`, `property_value_relation`, and `property_value_selection` tables. The ideal design uses one unified `property_value` table with JSONB values:

```sql
-- All projects owned by Jane
SELECT node_id
FROM property_value
WHERE property_schema_id = 'owner-schema-id'
  AND value->>'targetId' = 'jane-node-id';
```

This avoids the union-across-type-tables problem of EAV while keeping query performance.

#### Updated node interface

```ts
interface Node {
  id: string;
  workspaceId: string;
  kind: "page" | "block" | "class";
  classIds: string[];
  parentId: string | null;
  children: string[];
  content: InlineNode[];
  // properties are loaded from property_value table
  createdAt: string;
  modifiedAt: string;
  createdBy: string;
}
```

### 10.2 Identifiers: UUIDv7 Everywhere

The ideal design uses UUIDv7 as the single identifier type for all addressable entities. Integer IDs are removed entirely.

| Entity | Identifier |
|---|---|
| Nodes | UUIDv7 |
| Operations | UUIDv7 |
| Classes | UUIDv7 (classes are nodes) |
| Property schemas | UUID |
| Property values | UUID |
| Users | UUID |
| Workspaces | UUID |
| Blobs/files | SHA-256 hash |

#### Rationale

Notees today uses both integer IDs and UUIDs:

```sql
node (id SERIAL PRIMARY KEY, uuid UUID UNIQUE NOT NULL, ...)
```

This was pragmatic for PostgreSQL performance and migration, but it creates unnecessary complexity:

- An internal/public ID mapping layer everywhere.
- Risk of leaking internal IDs.
- Two identifiers for every entity.

In a local-first SQLite app scoped to a workspace, the storage overhead of UUIDs is negligible. The simplicity of one identifier type is decisive.

#### UUIDv7 specifically

Use UUIDv7 instead of UUIDv4 for anything where insertion order matters:

- Nodes created in a document are often read together.
- UUIDv7 encodes a timestamp, so sequential inserts land near each other in B-trees.
- This improves page locality and cache hit rates.

UUIDv4 is acceptable where random distribution does not hurt, but there is no reason not to standardize on UUIDv7.

#### Exceptions

UUIDs are not used for:
- **Hybrid Logical Clocks** — use `{ physical: number, logical: number }`.
- **Blob storage paths** — use SHA-256 hash.
- **Array indices** — children order and multi-value property indices remain integers.

#### Updated identifier rule

> Every addressable entity in the system is identified by a UUIDv7. The only exceptions are content hashes, sequence numbers, and array indices.

### 10.3 Updated System Architecture

```ts
// Relational tables
user, workspace, membership, property_schema, property_value

// Node table
node (id UUID PRIMARY KEY, kind TEXT, class_ids UUID[], parent_id UUID,
      content JSONB, ...)

// Children ordering (normalized CRDT sequence positions)
node_child_order (parent_id UUID, child_id UUID, position TEXT,
                  PRIMARY KEY (parent_id, child_id))

// Operation log
operation (id UUID PRIMARY KEY, workspace_id UUID, actor_id UUID,
           hlc JSONB, affected_node_ids JSONB, op_type TEXT,
           payload BYTEA, timestamp TIMESTAMPTZ)

// Checkpoints
snapshot (id UUID PRIMARY KEY, workspace_id UUID, hlc JSONB,
          state_hash TEXT, data BLOB, created_at TIMESTAMPTZ)

// Derived tables
edge, search_index

// File store
blobs/{hash[0:2]}/{hash}
```

### 10.4 Updated Comparison with Notees Today

| Notees Today | Converged Ideal Design |
|---|---|
| PostgreSQL server is source of truth | Local SQLite + operation log is source of truth |
| Mutable `node` rows | Immutable operations derive state |
| Boolean flags (`is_page`, `is_task`, …) | Three system kinds: `page`, `block`, `class` |
| `node.name` overloaded for title/content | `content` is always AST; `kind` disambiguates |
| Links parsed from `[[name]]` AST | Links are ID-based refs with labels |
| EAV property value tables per type | Unified `property_value` table with JSONB values |
| `asset` table and `kind: "asset"` | Assets are normal class instances with `file` property |
| Integer IDs + UUIDs | UUIDv7 everywhere |
| `node_yjs_state` + `node_revision` + `undo_log` | One operation log replaces all three |
| Server runs queries | Server is a sync relay; client runs queries |
| Markdown-ish as live model | Markdown is interchange only |

### 10.5 Updated Open Questions

16. Should property values be versioned as rows, or is operation-log history sufficient?
17. Should the `property_value` table store typed columns in addition to JSONB for common types (text, number, date) to enable better indexing?
18. Should UUIDv7 be used for property schema IDs too, or is UUIDv4 acceptable for schema entities?
19. How should workspace-scoped uniqueness constraints work with UUID primary keys (e.g., property schema names unique per workspace)?

---

## Part 11 — Further Design Decisions

This section records additional design decisions reached after the converged design was established.

### 11.1 Collaboration Model: Full CRDTs, Not Block Locking

Notees previously implemented and then removed Yjs in favor of a single-user-per-block locking model. For the ideal design, **full CRDT-based real-time collaboration** is chosen instead.

Rationale:
- CRDTs are the only model that satisfies offline-first, real-time collaboration, and self-hosting without central coordination.
- They provide mathematically guaranteed convergence.
- They scale naturally from single-user to multi-user.
- Block locking artificially restricts users and is not the ideal user experience.

The previous Notees decision to drop Yjs is treated as a pragmatic constraint of that codebase and timeline, not as evidence that CRDTs are wrong architecturally.

### 11.2 CRDT Scope

| Data Structure | CRDT Type |
|---|---|
| Block tree (children ordering per parent) | CRDT sequence (Yjs Y.Array / YATA / RGA) |
| Inline block content (text, links, formatting, embeds) | CRDT rich text (Yjs Y.XmlFragment equivalent) |
| Property values | LWW register or multi-value register |
| Multi-select / multi-relation properties | OR-Set / add-wins set |
| Class assignments on a node | OR-Set |
| Node deletion | Tombstone + LWW |

### 11.3 Operation Log and CRDT Relationship

The operation log stores **high-level user-intent operations**. The CRDT state is the merged runtime state derived from those operations.

Operations are ordered with **Hybrid Logical Clocks (HLC)**:

```ts
hlc: { physical: number; logical: number }
```

HLC provides causality tracking with constant-size timestamps.

For inline text edits, the operation payload carries a **CRDT update blob** rather than a character-by-character operation list:

```json
{
  "type": "node.updateContent",
  "nodeId": "block-uuid",
  "crdtUpdate": "base64-encoded-Uint8Array"
}
```

This keeps the operation log as the source of truth while leveraging mature CRDT merge semantics for text.

#### Operation envelope

Operations have a clear split between routing metadata and encrypted payload:

```json
{
  "id": "op-uuid",
  "workspaceId": "workspace-uuid",
  "actorId": "actor-uuid",
  "hlc": { "physical": 1234567890, "logical": 5 },
  "affectedNodeIds": ["node-a", "node-b"],
  "opType": "node.move",
  "encryptedPayload": "base64-or-binary"
}
```

Envelope fields are unencrypted so the server can route operations, enforce workspace/node permissions, and serve catch-up queries. `affectedNodeIds` is empty for workspace-private routing and populated for node-level shares.

### 11.4 Operation Schema

```ts
// Structural operations
{ type: "node.create", nodeId, kind, parentId, index, initialContent?, classIds? }
{ type: "node.delete", nodeId }
{ type: "node.move", nodeId, newParentId, newIndex }
{ type: "node.updateContent", nodeId, crdtUpdate }
{ type: "class.assign", nodeId, classId }
{ type: "class.unassign", nodeId, classId }

// Property operations
{ type: "property.set", propertyValueId, nodeId, schemaId, index, value }
{ type: "property.unset", propertyValueId, nodeId, schemaId, index }

// Schema operations (rare, but required for sync)
{ type: "propertySchema.create", schemaId, name, type, config }
{ type: "propertySchema.update", schemaId, configDelta }
{ type: "class.create", classId, name, propertySchemaIds, extends }
{ type: "class.update", classId, propertySchemaIds?, extends? }
```

### 11.5 Derived State Strategy

Derived SQLite tables are **eagerly maintained** but **rebuildable** from the operation log.

- Every committed operation updates derived tables in the same SQLite transaction.
- Derived tables include `node`, `property_value`, `edge`, `search_index`.
- Children ordering is normalized into `node_child_order(parent_id, child_id, position)` rather than a JSON array, so moving one child does not rewrite the parent's entire child list.
- The operation log remains the source of truth; derived tables can be dropped and rebuilt by replaying operations.
- **Snapshots** capture the complete derived state up to a specific HLC. Startup loads the latest snapshot and replays only newer operations.

This gives both performance and recoverability.

### 11.6 Query Model

- **Primary query language:** QueryAST compiled to SQLite SQL.
- **Power-user query language:** Datalog is intentionally excluded from the initial ideal design.

Rationale: Datalog is powerful but adds a second query language to document, secure, and maintain. QueryAST should be made expressive enough for the vast majority of use cases.

### 11.7 Search Strategy

Full-text search uses SQLite FTS5:

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  node_id UNINDEXED,
  content,
  tokenize='porter unicode61'
);
```

Indexed content includes node display names, block inline text, property text values, and class/property schema names.

Vector/semantic search is out of scope for the ideal core. It can be added later as an optional plugin or index.

### 11.8 Undo Model

Undo is implemented as **per-user inverse operations**:

- Every operation has a computable inverse operation.
- Each user maintains their own undo stack of operations they initiated.
- Undo appends the inverse operation to the operation log.
- Undo is local to the user; one user cannot undo another user's actions.

### 11.9 Permissions

Three permission layers:

| Layer | Scope |
|---|---|
| Workspace | User is a member with role `owner`, `admin`, `editor`, or `viewer`. |
| Node | Node can be shared with specific users or made public. |
| Class | Controls who can create or modify class schemas. |

Permissions are enforced on the server before operations are accepted and broadcast. The client also enforces permissions for UI purposes, but the server is the authority.

### 11.10 Multi-Workspace Storage

Each workspace is isolated in its own SQLite file on the client:

- Switching workspaces means opening a different SQLite file.
- The sync server routes operations by workspace.
- This simplifies backup, export, and per-workspace encryption.

### 11.11 Client/Server Storage Split

| Layer | Store | Holds |
|---|---|---|
| Client | SQLite | Decrypted derived state, local operation queue, search index, blobs. |
| Server | PostgreSQL | Encrypted operation log, users, workspaces, memberships, shares, public pages. |

"SQLite everywhere" was revised. SQLite is correct for the client; PostgreSQL is correct for the server.

### 11.12 Server-Side PostgreSQL Schema

```sql
-- Account and tenant metadata
"user" (id UUID PRIMARY KEY, email, password_hash, ...)
workspace (id UUID PRIMARY KEY, name, owner_id, ...)
membership (workspace_id UUID, user_id UUID, role TEXT, PRIMARY KEY (workspace_id, user_id))

-- Sharing metadata
node_share (node_id UUID, user_id UUID, role TEXT)
node_public_share (node_id UUID PRIMARY KEY, slug TEXT, password_hash TEXT)

-- Encrypted operation log
operation (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  hlc JSONB NOT NULL,                 -- { physical, logical }
  affected_node_ids JSONB NOT NULL DEFAULT '[]',
  op_type TEXT NOT NULL,
  payload BYTEA NOT NULL,             -- encrypted
  timestamp TIMESTAMPTZ NOT NULL
)
```

### 11.13 Privacy and Routing Model

Operations are end-to-end encrypted by default. The server routes operations based on metadata in the operation envelope.

Three routing options were considered:

| Option | Model | Trade-off |
|---|---|---|
| A | Workspace-level routing only; client-side node permission enforcement. | Strongest privacy; clients may learn of nodes they cannot access. |
| B | Node IDs in operation envelope; server enforces node-level shares. | Server can enforce permissions; server learns node-level activity. |
| C | Hybrid — workspace-level encryption by default; node-level envelope metadata only for explicitly shared nodes. | Balance of privacy and practical enforcement. |

**Chosen model: Option C.**

- Workspace-private operations are encrypted with the workspace key and routed by workspace; `affectedNodeIds` may be empty.
- Node-level routing metadata (`affectedNodeIds`) is included only when a node is explicitly shared outside its workspace, allowing the server to enforce share permissions without leaking the entire graph structure.

### 11.14 Encryption

- **Transport:** TLS for all client-server communication.
- **At-rest:** Local SQLite encrypted (SQLCipher or platform keychain); server PostgreSQL encrypted at rest.
- **End-to-end:** Operation payloads encrypted by default; server cannot read workspace-private content.

### 11.15 Updated Comparison with Notees Today

| Notees Today | Converged Ideal Design |
|---|---|
| PostgreSQL server is source of truth | Local SQLite is primary; operation log is source of truth |
| Server runs queries and holds content | Server is relay + metadata; client holds decrypted state |
| Mutable `node` rows | Immutable operations derive state |
| Boolean flags (`is_page`, `is_task`, …) | Three system kinds: `page`, `block`, `class` |
| `node.name` overloaded for title/content | `content` is always AST; `kind` disambiguates |
| Links parsed from `[[name]]` AST | Links are ID-based refs with labels |
| EAV property value tables per type | Unified `property_value` table with JSONB values |
| `asset` table and `kind: "asset"` | Assets are normal class instances with `file` property |
| Integer IDs + UUIDs | UUIDv7 everywhere |
| `node_yjs_state` + `node_revision` + `undo_log` | One operation log + CRDT state replaces all three |
| Block-locking collaboration | Full CRDT collaboration |
| Markdown-ish as live model | Markdown is interchange only |
| SQLite only on backend | SQLite on clients, PostgreSQL on server |

### 11.16 Updated Open Questions

20. Should the operation log use vector clocks or hybrid logical clocks (HLC)?
21. Should operation payloads be encrypted with workspace keys or per-user keys?
22. How are workspace encryption keys rotated and distributed?
23. Should the server store operation history forever, or implement compaction/retention?
24. How are public share pages rendered if the server cannot decrypt operations?
25. Should class schema operations be encrypted, or are they server-visible metadata?
26. How do plugins/extensions interact with the operation log and derived state?

### 11.17 Operation Log Compaction

Over time, workspaces can accumulate millions or billions of operations. Snapshots bound startup replay, but the raw log still grows. Compaction records which operation ranges have been superseded by a snapshot without changing the source-of-truth model:

```sql
compacted_operation_segment (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  from_hlc JSONB NOT NULL,
  to_hlc JSONB NOT NULL,
  snapshot_id UUID NOT NULL,
  operation_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ
);
```

Rules:

- A segment may be created only when a snapshot exists that fully reproduces the state derived from operations in the `[from_hlc, to_hlc]` range.
- Compacted operations can be archived or deleted; the segment record proves they are reproducible from the snapshot.
- The operation log remains authoritative in principle; compaction is a storage optimization and audit convenience.
- Clients and server can independently decide retention policies based on segment records.

This resolves Q23 (operation retention) at the architectural level: store forever by default, but compact ranges that are fully captured by snapshots.

---

## Part 12 — Core Design Extensions

Based on comparison with rival apps, the following are elevated from "future features" to **core parts of the ideal architecture**. AI integration is explicitly excluded as a built-in layer; instead, AI access is provided via an external API/skill.

### 12.1 Plugin Architecture (Core)

The system must be extensible by plugins from day one. Plugins can extend:

- **Property types:** custom data types with their own editor, validator, and renderer.
- **Block types:** custom content blocks (e.g., code block with syntax highlighting, Mermaid diagram, embedded map).
- **Views:** custom ways to render query results or node collections.
- **Import/export formats:** custom parsers and serializers.
- **Operations:** plugins can define their own operation types, validated by the plugin.

Implications:
- The operation schema is open-ended; unknown operation types are preserved and forwarded but only applied if a plugin handles them.
- The content AST node types are extensible; unknown nodes round-trip as opaque JSON.
- Property value shapes are extensible; the core validates only built-in types.
- Plugins declare a manifest with schemas for the operations, block types, and property types they introduce.

Plugin operations must still respect workspace isolation, permissions, and CRDT merge semantics.

### 12.2 Whiteboard / Canvas Block (Core)

A whiteboard is a block with a `canvas` property containing:

```ts
interface WhiteboardData {
  viewport: { x, y, zoom };
  elements: Array<NodeElement | EdgeElement | TextElement | ShapeElement>;
  background: { color?, grid? };
}
```

Canvas elements can reference nodes by ID. A node dropped onto a canvas appears as an element that links back to the source node. Changes to the source node update its canvas representation.

The whiteboard block is just another block type. It can be embedded in pages, nested in outlines, or opened full-screen.

### 12.3 Computed Properties (Core)

Computed properties are defined by a computation strategy, not by a property type. The schema separates the scalar return type from the computation:

```ts
interface PropertySchema {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "select" | "multi_select" | "node" | "checkbox" | "file";
  computed?: {
    kind: "formula" | "rollup" | "query";
    expression: string;   // restricted safe expression, QueryAST, or relation path
  };
  config: Record<string, any>;
}
```

- `formula`: computes a value from the node's own properties and content.
- `rollup`: aggregates a property across related nodes (e.g., sum of task estimates in a project).
- `query`: computes a boolean or count from a QueryAST subquery.

The `type` field tells the UI how to render and validate the result. The `computed` field tells the engine how to produce it. Computed properties are **derived values**, not stored in `property_value`. They are recomputed on read and cached with dependency tracking.

Dependency tracking:
- Each computed property declares its dependencies (property schemas, relation paths, query scopes).
- The derived state layer invalidates cached computed values when dependencies change.

Example:
```ts
{
  id: "total-estimate-schema-id",
  name: "Total Estimate",
  type: "number",
  computed: {
    kind: "rollup",
    expression: 'sum(tasks.estimate)'
  },
  config: {}
}
```

### 12.4 Live Query Blocks (Core)

A query block is a block whose content is a live QueryAST result:

```ts
interface QueryBlockData {
  title: string;
  queryAST: QueryAST;
  viewMode: "list" | "table" | "kanban" | "card" | "calendar" | "graph";
  shownProperties: string[];
  sortEntries: Array<{ key, direction }>;
  groupBy?: string;
}
```

Live query blocks:
- Are embedded in pages like any other block.
- Update automatically when the underlying data changes.
- Are the primary way to build dashboards and dynamic views.
- Are the equivalent of Anytype Sets, Tana live search nodes, and Notion linked databases.

### 12.5 Graph View (Core)

A built-in graph view visualizes the `edge` table:

- Nodes are pages/classes/blocks.
- Edges are references, property relations, class instances, or tags.
- Filters by edge type, class, date range.
- Clustering by class.
- Physics-based layout.
- Clicking a node opens it.

The graph view is not a separate subsystem; it is a read-only renderer over the derived edge table.

### 12.6 Publishing (Core)

Selected nodes can be published as public pages:

- `node_public_share` table maps a node to a public slug.
- The server renders a static HTML page from the node's content and referenced subgraph.
- Published pages can be password-protected.
- The render respects public-share permissions; private nodes referenced from a public page appear as broken links or are excluded.
- A static-site export mode generates a full publishable bundle.

Publishing is core because it turns the knowledge graph into a shareable website, matching Notion Sites and Capacities publishing.

### 12.7 AI Access: External API / Skill, Not Built-In Layer

There is no built-in AI layer. Instead, the system exposes a scoped API and documents a skill (e.g., for Kimi Code, Claude, or other agentic tools) that allows AI agents to:

- Read nodes, classes, properties, and query results.
- Submit operations on behalf of the user, subject to permissions.
- Search the graph.

AI agents interact with the same operation log as human users. They are just another actor. The skill documents:
- Authentication (API keys, scopes).
- How to read the graph.
- How to submit operations.
- Constraints and safety rules.

This keeps AI as an external capability rather than a core dependency, while making the system AI-ready by virtue of its structured, queryable, operation-based design.

### 12.8 Policies

Several long-running policies must be explicit in the architecture.

#### Tombstone garbage collection

Deleted nodes remain as tombstones in the operation log so CRDTs can converge. Tombstones can be compacted only after all known replicas have observed the deletion and after any configured retention window has passed. The client performs compaction during snapshot creation; the server never discards operations unilaterally.

#### Key rotation and member removal

Workspace keys use a wrapped-master-key hierarchy:

- A workspace master key encrypts operation payloads.
- The master key is wrapped for each member's public key and stored in `workspace_key`.
- Rotation generates a new master key, re-wraps it for current members, and issues a `workspace.keyRotate` operation.
- Removed members keep any historical data they already downloaded; they cannot decrypt new operations because they do not receive the new master key. Historical access is a sharing decision, not a revocable lock.

#### Schema evolution

When a property schema changes type or config, existing values are not automatically migrated. Instead:

- The schema change is recorded as an operation.
- Readers apply the new validation to existing values lazily.
- A background derived-state task flags values that no longer validate.
- Users may run an explicit migration operation to rewrite invalid values.

This preserves history and avoids silent data loss.

#### Cross-workspace references

References across workspaces are not supported in the core model. A node belongs to exactly one workspace. If a public page or published snapshot references content, that content is either copied into the destination workspace or rendered as an external link. Workspace isolation is never violated.

### 12.9 Updated System Architecture Overview

```
Client (per workspace, SQLite file)
├── operation log
├── derived nodes / property_value / edges / search_index
├── CRDT state for active blocks
└── plugin registry

Server (PostgreSQL)
├── encrypted operation log
├── users / workspaces / memberships
├── shares / public shares
└── plugin metadata

Core concepts
├── page / block / class (node kinds)
├── property_schema / property_value (tables)
├── operations (immutable, CRDT-aware)
├── QueryAST → SQL
├── plugin-extensible block/property/view types
├── whiteboard block
├── live query block
├── computed properties (formula/rollup/query)
├── graph view
├── publishing
├── policies (tombstone GC, key rotation, schema evolution, cross-workspace refs)
└── compaction (operation-log maintenance)
```

### 12.10 Updated Open Questions

27. What is the plugin manifest format and lifecycle?
28. How are plugin operations validated and sandboxed?
29. Should computed properties support JavaScript/Python expressions, or a restricted expression language?
30. How does dependency tracking for computed properties interact with CRDT merges?
31. Should whiteboard elements be separate nodes, or embedded canvas data?
32. What is the public rendering pipeline for published pages?
33. What scopes should the AI/agent API expose?

---

## Part 13 — Final Resolutions to Open Questions

All remaining open questions are resolved below using the best option for the ideal design.

### 13.1 Operations & Sync

| Question | Resolution |
|---|---|
| Q20 — Clock type | **Hybrid Logical Clocks (HLC).** Constant size, provides causality and physical time. |
| Q21 — Encryption keys | **Workspace symmetric key.** Operation payloads encrypted with workspace key; key wrapped per member. |
| Q22 — Key rotation | **Wrapped master key hierarchy.** Workspace master key is re-wrapped for active members on rotation. |
| Q23 — Operation retention | **Store forever by default; compact ranges captured by snapshots.** `compacted_operation_segment` tracks ranges that can be archived/deleted. Audit trail and source of truth are preserved. |

### 13.2 Sharing & Publishing

| Question | Resolution |
|---|---|
| Q24 — Public page rendering | **Static snapshot publishing.** Client renders a static HTML bundle for public pages; server serves it. |
| Q25 — Class schema encryption | **Encrypted with workspace key.** Class schemas are private workspace content. |

### 13.3 Plugins

| Question | Resolution |
|---|---|
| Q26/Q27 — Plugin operation model | **Plugin manifest registers operation types, block types, property types, and derived-state handlers.** Core forwards unknown operations; plugins apply them. |
| Q28 — Plugin validation/sandboxing | **JSON Schema validation + sandboxed execution.** Operations validate against declared schemas; plugin code runs in Web Workers / restricted processes. |

### 13.4 Computed Properties

| Question | Resolution |
|---|---|
| Q29 — Expression language | **Restricted expression language with plugin-extensible safe functions.** No arbitrary code execution for core computed properties. |
| Q30 — Dependency tracking with CRDTs | **Computed values are pure functions of converged CRDT state.** Dependency graph invalidates caches after operations apply. |
| Q30b — Type vs computed strategy | **`type` and `computed` are separate.** `type` declares the scalar/structural return type; `computed: { kind, expression }` declares the computation strategy. |

### 13.5 Whiteboard

| Question | Resolution |
|---|---|
| Q31 — Whiteboard elements | **Hybrid model.** Freehand shapes/text/connectors are embedded canvas data; nodes on the canvas are references to real graph nodes. |

### 13.6 AI / Agent API

| Question | Resolution |
|---|---|
| Q32 — Public rendering pipeline | Resolved by Q24: static snapshot pipeline. |
| Q33 — Agent API scopes | **read / write / search / admin.** Write operations are auditable and subject to confirmation policy. |

### 13.7 Final Open Questions List

The architecture is converged at the conceptual level. A few areas remain explicitly open as architectural decisions rather than fully resolved implementation details:

1. **CRDT implementation complexity** — semantics are clear; library choice and integration effort are not.
2. **SQLite OPFS + wasm maturity** — shape is right; platform behavior and performance still need validation.
3. **Plugin sandboxing model** — direction is Web Workers / restricted processes; concrete sandbox TBD.
4. **Computed property dependency tracking at scale** — policy is defined; cache invalidation engine is not.
5. **Workspace key rotation UX** — cryptographic flow is specified; user-facing rotation/recovery flow needs design.
6. **Tombstone GC timing** — retention window is a policy, not a resolved constant.
7. **Schema migration ergonomics** — lazy validation plus explicit migration is the rule; UI for reviewing/applying migrations needs design.
8. **Cross-workspace references** — core model forbids them; safe copy-or-link semantics later is an open product decision.

---

## Part 14 — Final Architecture Summary

### Priorities

1. Offline-first & local performance
2. Real-time collaboration
3. Structured querying power
4. Self-hosted server

### Core Philosophy

- Every piece of content is a node.
- Nodes have classes; classes define properties.
- Properties are schema-driven and assigned through UI controls.
- References are ID-based with display labels.
- The immutable operation log is the source of truth.
- CRDTs handle concurrent edits.
- Local SQLite is the primary runtime store; PostgreSQL on the self-hosted server holds encrypted operations and sharing metadata.
- Markdown is a round-trip interchange format, not a live data source.

### System Kinds

Only three node kinds exist:

- `page`
- `block`
- `class`

Everything else — task, journal, image, person, project — is a user-defined or built-in class.

### Non-Node Tables

- `user`
- `workspace`
- `membership`
- `property_schema`
- `property_value`

### Client Storage (SQLite per workspace)

- `operation` — immutable operation log
- `snapshot` — derived-state checkpoints up to a specific HLC
- `node` — derived block tree and content
- `node_child_order` — normalized CRDT sequence positions for children ordering
- `property_value` — derived property values
- `edge` — derived reference/property graph
- `search_index` — FTS5 search index
- `blob` directory — content-addressed files

### Server Storage (PostgreSQL)

- `operation` — encrypted operation log (with `hlc` and `affected_node_ids` envelope fields)
- `user`, `workspace`, `membership` — account metadata
- `node_share`, `node_public_share` — sharing metadata

### Sync

- Self-hosted server is an operation relay.
- Operations are encrypted end-to-end with workspace keys.
- Operation envelopes expose `affectedNodeIds` for node-level sharing and routing.
- CRDTs merge concurrent edits for block tree, inline text, properties, and class assignments.
- Hybrid Logical Clocks order operations.
- Snapshots avoid full log replay on startup and catch-up.
- `compacted_operation_segment` tracks ranges fully captured by snapshots for long-term log maintenance.

### Query & Search

- QueryAST compiles to SQLite SQL.
- Live query blocks embed dynamic QueryAST results in pages.
- FTS5 for full-text search.

### Collaboration

- Full CRDT-based real-time collaboration.
- No block locking.
- Presence, cursors, and recent-change highlights for UX.

### Extensibility

- Plugin architecture for property types, block types, views, import/export, and operations.
- Whiteboard block.
- Computed properties (formula, rollup, query).
- Graph view.
- Publishing via static snapshots.
- AI/agent access via external scoped API/skill.
- Explicit policies for tombstone GC, key rotation, schema evolution, and cross-workspace references.

### Identifiers

- UUIDv7 for all addressable entities.
- SHA-256 for content-addressed blobs.
- No integer IDs.

### Security

- TLS for transport.
- End-to-end encryption for workspace operations.
- At-rest encryption for SQLite and PostgreSQL.
- Server-side permission enforcement for workspace/node access.
- Plugin sandboxing.

---

## Part 15 — What Would Notees Need to Change

To move from the current Notees architecture to this ideal design, the following would need to change:

| Current Notees | Ideal Design |
|---|---|
| PostgreSQL as source of truth | SQLite local + operation log as source of truth |
| Server runs queries | Server relays operations; client runs queries |
| Boolean flags on `node` | Three system kinds + classes |
| `node.name` for title/content | `content` AST always |
| `[[name]]` links | ID-based refs with labels |
| EAV property value tables | Unified `property_value` table |
| `asset` table / `kind: "asset"` | Normal class instances with `file` property |
| Integer IDs + UUIDs | UUIDv7 only |
| `node_yjs_state` + `node_revision` + `undo_log` | One operation log + CRDT state |
| Block-locking collaboration | Full CRDT collaboration |
| Markdown as live model | Markdown interchange only |
| SQLite only on backend | SQLite on clients, PostgreSQL on server |
| Fixed block/property types | Plugin-extensible types |
| No whiteboard/core query blocks | Whiteboard and live query blocks are core |
| No computed properties | Formula/rollup/query properties are core |
| No graph view | Graph view is core |
| No publishing | Publishing via static snapshots is core |

---

This concludes the ideal design phase. The full working document is ready to be distilled into a formal design spec.
