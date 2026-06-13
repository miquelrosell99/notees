# Notees Linking & Filtering Assessment

> Generated: 2026-06-12 (revised 2026-06-13)
>
> Scope: Review and assess Notees node linking and filtering logic, compare against Logseq, Roam Research, and Obsidian, and suggest improvements.

## TL;DR

Notees is **not a broken version of Roam/Logseq**; it uses a different linking model that is appropriate for its data model. Pages are namespaced containers (different parents/classes can produce pages with identical display names), so title-based `[[Page Name]]` resolution is intentionally avoided in favor of stable, UUID-backed links inserted through the `@` trigger and slash commands.

The real gaps are:

1. **Unlinked references are just text search**, not a true mention index with one-click promotion.
2. **Block embeds / transclusion** exist as a slash command but should use a floating transclusion UI rather than inline editing.
3. **QueryAST is GUI-only**; this is acceptable for most users but is a power-user limitation.

**Completed:** tags now live in `node.tag_ids` (like `class_ids`), with `node_link.is_tag` removed.

The earlier recommendation to adopt `[[Page Name]]` / `((block-uuid))` syntax is **rejected** as architecturally incompatible with Notees's namespaced page model.

## Comparison Matrix

| Capability | Notees | Roam | Logseq | Obsidian |
|---|---|---|---|---|
| Page links | ✅ Via `@` trigger / slash command | ✅ `[[Page]]` | ✅ `[[Page]]` (with namespace disambiguation) | ✅ `[[Page]]` |
| Block refs | ✅ Via *Insert Block Link* slash command | ✅ `((block))` | ✅ `(( ))` | ⚠️ Plugin / embed only |
| Block embeds / transclusion | ⚠️ Slash command exists; live-edit behavior TBD | ✅ Live editable | ✅ Live editable | ⚠️ Embed plugin |
| Bidirectional backlinks | ✅ Linked + property refs | ✅ Linked + unlinked | ✅ Linked + unlinked | ✅ Linked + unlinked |
| Unlinked mentions | ⚠️ Text search only | ✅ True mentions | ✅ True mentions | ✅ True mentions |
| Aliases / synonyms | ✅ | ✅ | ✅ `alias::` | ✅ Aliases |
| Graph view | ✅ Page-only + local mode | ✅ Block-aware | ✅ Block-aware | ✅ Page + tag |
| Query language | ⚠️ GUI QueryAST → SQL | ✅ Datalog | ✅ Datalog | ⚠️ Dataview plugin |
| Local-first / offline | ✅ PWA + service worker | ❌ Cloud | ✅ Yes | ✅ Yes |
| Daily journal | ✅ | ✅ | ✅ | ⚠️ Template / plugin |
| Class / property system | ✅ Strong | ❌ Weak | ⚠️ Properties | ⚠️ Properties / Dataview |

## 1. Link Syntax & Source of Truth

### Notees today

- Everything is a `node`. Pages are nodes with `is_page = TRUE`; they act as containers/anchors for blocks and child pages.
- Content is stored as JSON AST in `node.name` for blocks.
- Links are AST nodes with `ref_type: "node"` and a compound `link_id` of `"nodeUuid:linkUuid"`.
- Users insert links with the **`@` trigger** or the **`/ → Insert Page Link / Insert Block Link`** slash commands.
- `LinkParsingService.update_node_links()` re-parses block AST on save and rebuilds `node_link` rows.
- Pages themselves do **not** parse inline links in their `name` field by design: a page's content lives in its child blocks.

### Why Notees does not use `[[Page Name]]`

In Notees, multiple pages can share the same display name if they live under different parents or classes. Resolving `[[Project Alpha]]` would therefore be ambiguous. The product intentionally avoids this by:

1. Using UUID-backed pills as the source of truth.
2. Letting the `@` picker disambiguate by context (parent path, class, etc.).
3. Keeping links stable when targets are renamed or when a new同名 page is created.

Logseq has moved away from pure title-based linking for the same namespace reasons. Notees sidesteps the problem entirely by using the picker → UUID flow.

### What competitors do

- `[[Page Name]]` resolves by page title (works only when titles are globally unique).
- `((block-uuid))` resolves a specific block.
- Block embeds let you edit the original from any embed location.
- Aliases let one page answer to multiple names, which powers unlinked-mention detection.

### Recommendations

1. **Keep UUID-backed links.** Do not introduce `[[Page Name]]` resolution.
2. **Keep the `@` picker** as implemented; breadcrumbs and class context are already present.
3. **Implement block embeds as a floating transclusion UI**, not inline editable embeds.
4. **Keep aliases/synonyms** as already implemented.

## 2. Backlinks & Unlinked Mentions

### Notees today

- `GET /nodes/{id}/backlinks` returns explicit `node_link` rows.
- `GET /nodes/{id}/linked-references` is richer: context, breadcrumbs, property provenance.
- A default view `unlinked_references` exists but is implemented as a `ContentCondition` search for the current node name.

### Problems

- The unlinked-references view cannot distinguish "mentions the exact name but is not linked" from "mentions a string that happens to match the name."
- There is no way to **promote an unlinked mention to a real link** in one click.
- Aliases are already supported; the unlinked-references view should use them.

### What competitors do

- **Obsidian Backlinks pane** has two sections: *Linked mentions* and *Unlinked mentions*. Each unlinked mention can be converted to a link.
- **Roam/Logseq** show unlinked references on the target page and let you link them.
- All three treat aliases/synonyms as part of the mention index.

### Recommendations

1. Build a real **mention candidate table** separate from `node_link`: after parsing content, scan plain text for known page names + aliases and store candidate mentions.
2. Expose an endpoint to **convert a mention to a link** (rewrites the source AST, inserts the link node, removes the plain-text occurrence).
3. Allow the user to **ignore false-positive mentions** per page/alias.
4. Surface unlinked mentions in the backlinks panel, not just as a query view.

## 3. Block Embeds / Transclusion

### Notees today

- A slash command *Embed Node* exists.

### What competitors do

- **Roam/Logseq**: block embeds render the block inline and editable.
- **Obsidian**: `![[note]]` or block embeds via `![[note#^block-id]]` open a floating transclusion preview rather than editing inline.

### Recommendations

1. Do **not** allow inline editing of embedded nodes inside other nodes.
2. Implement a **floating transclusion UI** (similar to Obsidian/Logseq hover previews) that shows the embedded node's content in a popup/panel.
3. Track embeds in `node_link` (or a separate embed table) so they show up in backlinks.

## 4. Graph View

### Notees today

- `GraphView.tsx` fetches links via `POST /nodes/links`.
- Backend returns `reference`, `parent`, `class`, `extends`, `property-reference`, and `cooccurrence` link types.
- The endpoint only sees **page nodes** (`is_page = TRUE`), so block-level references are aggregated to their parent page.

### Assessment

This is an **intentional design choice**, not a gap. Because Notees pages can be namespaced and blocks are numerous, a block-level force graph would be noisy and less useful than a page-level graph. The graph answers "how do my high-level containers connect?" which matches the page-as-anchor mental model.

### What competitors do

- Roam's graph is natively block-aware.
- Logseq's graph view can show pages and blocks.
- Obsidian's graph is page/tag-based but dense and filterable.

### Recommendations

1. **Keep the graph page-only.**
2. Local graph view is already implemented.
3. Allow filtering edges by type and weight (hide weak co-occurrence links).
4. Consider a **hierarchical view** using the closure table (`parent → child`) alongside reference edges.

## 5. Querying & Filtering

### Notees today

- **QueryAST**: visual tree builder with conditions for class, property, content, reference, parent/child, flag, page.
- Compiles to PostgreSQL via `query_ast_sql.py`.
- Placeholders like `{current_node_uuid}` are string-substituted into the AST.
- A `class_path` condition exists in the frontend config but duplicates the behavior of the existing class filter, which already resolves inheritance via `class_extend`.

### What competitors do

- **Roam/Logseq**: Datalog queries. Extremely powerful but steep learning curve.
- **Obsidian**: Dataview plugin uses a SQL-like DSL; simpler but still text-based.
- All three allow power users to write queries as text.

### Problems

- QueryAST is **GUI-only**. Power users cannot copy/paste or version-control queries.
- String-based placeholder substitution is fragile.
- The `class_path` condition duplicates the existing class filter and should be removed or consolidated.
- No aggregation (count, sum, group by) in QueryAST.

### Recommendations

1. **Remove or consolidate `class_path`** with the existing class filter that already handles inheritance.
2. Replace string placeholder substitution with typed parameters.
3. Add **aggregation operators** (count, group by) for dashboards.
4. Add **relative date operators** ("today", "last 7 days", "this week") for journal/task queries.
5. Optional: add a **text query language** that compiles to QueryAST / SQL for power users.

## 6. Tag, Class & Property Filtering

### Notees today

- Tags are stored in `node.tag_ids` (like `node.class_ids`).
- Classes are stored in `node.class_ids` with inheritance via `class_extend`.
- Properties have scalar, selection, and relation value tables.

### Problems

- Inline class links are not treated as references in queries, creating an inconsistency.

### Recommendations

1. Remove or consolidate the `class_path` condition with the existing class filter that already resolves inheritance.
2. Consider materializing a `node.search_text` column to avoid `jsonb_path_query` on every content comparison.

## Prioritized Improvement Roadmap

### P0 — Fix drift and inconsistency

1. Remove or hide the `class_path` QueryAST condition if the existing class filter already handles inheritance. Consolidate on one behavior.
2. Audit and document current block embed behavior; implement floating transclusion UI.

### P1 — Discoverability

3. Build a real unlinked-mentions index using page names + aliases.
4. One-click "link this mention" from backlinks panel.
5. Allow ignoring false-positive mentions per page/alias.

### P2 — Power features

6. Text-based query language compiling to QueryAST.
7. Aggregation in QueryAST for dashboards.

### P3 — Quality of life

8. Materialized `search_text` column for performance.

## Architectural Observations

The Notees design is well-positioned to support these improvements:

- **AST as source of truth** makes it straightforward to rewrite links in place (for mention-to-link conversion).
- **`node_link` table** is the right primitive for explicit graph edges.
- **Closure table (`node_path`)** already supports fast hierarchy queries.
- **Property/value tables** already support structured filtering.
- **UUID-backed pills** are the correct source of truth for a system with namespaced, non-unique page names.

Main architectural debt to address first:

- Remove or consolidate the `class_path` condition with the existing class filter.
- Move from string-based placeholder substitution to typed parameters in QueryAST execution.
- Introduce a **mention candidate table** separate from `node_link` so unlinked mentions can be tracked, ignored, and promoted.
