# Notees Linking & Filtering Assessment

> Generated: 2026-06-12
>
> Scope: Review and assess Notees node linking and filtering logic, compare against Logseq, Roam Research, and Obsidian, and suggest improvements.

## TL;DR

Notees has a **solid architectural foundation** for a block-based, linked note system, but it currently sits between Obsidian's page-centric model and Roam/Logseq's block-centric model without fully committing to either. The biggest gaps are:

1. **Page links are not parsed** — pages cannot contain `[[...]]` references.
2. **No block-reference syntax** — there is no `((block-uuid))` equivalent; all links collapse to node links.
3. **Unlinked references are just text search**, not true "mentions that could become links."
4. **Graph view is page-only**, losing block-level resolution.
5. **No aliases / synonyms**, so unlinked-mention discovery is brittle.
6. **No block embeds / transclusion**.
7. **QueryAST is GUI-only**; there is no power-user text query language.

## Comparison Matrix

| Capability | Notees | Roam | Logseq | Obsidian |
|---|---|---|---|---|
| Page links (`[[Page]]`) | ❌ Pages cannot contain inline links | ✅ Core | ✅ Core | ✅ Core |
| Block refs (`((block))`) | ❌ No distinct syntax | ✅ Invented it | ✅ `(( ))` | ⚠️ Plugin / embed only |
| Block embeds / transclusion | ❌ | ✅ Live editable | ✅ Live editable | ⚠️ Embed plugin |
| Bidirectional backlinks | ✅ Linked + property refs | ✅ Linked + unlinked | ✅ Linked + unlinked | ✅ Linked + unlinked |
| Unlinked mentions | ⚠️ Text search only | ✅ True mentions | ✅ True mentions | ✅ True mentions |
| Aliases / synonyms | ❌ | ✅ | ✅ `alias::` | ✅ Aliases |
| Graph view | ⚠️ Page-only | ✅ Block-aware | ✅ Block-aware | ✅ Page + tag |
| Query language | ⚠️ GUI QueryAST → SQL | ✅ Datalog | ✅ Datalog | ⚠️ Dataview plugin |
| Local-first / offline | ✅ PWA + service worker | ❌ Cloud | ✅ Yes | ✅ Yes |
| Daily journal | ✅ | ✅ | ✅ | ⚠️ Template / plugin |
| Class / property system | ✅ Strong | ❌ Weak | ⚠️ Properties | ⚠️ Properties / Dataview |

## 1. Link Syntax & Source of Truth

### Notees today

- Content is stored as JSON AST in `node.name`.
- Links are AST nodes with `ref_type: "node"` and a compound `link_id` of `"nodeUuid:linkUuid"`.
- User-visible syntax is `[[UUID]]` or `[label]([[UUID]])`.
- `LinkParsingService.update_node_links()` re-parses the AST on save and rebuilds `node_link` rows.

### Problems

- The syntax is **UUID-based, not name-based**. Users cannot type `[[Project Alpha]]` and have it resolve to a page; they must select an existing node.
- **Page nodes explicitly skip link parsing** (`if is_page: return []`). This means page titles/bodies cannot reference other pages, a severe restriction for a wiki-style tool.
- There is **no separate `((block-uuid))` syntax**; block references and page references use the same `[[...]]` form.

### What competitors do

- `[[Page Name]]` resolves by page title.
- `((block-uuid))` resolves a specific block.
- Block embeds let you edit the original from any embed location.
- Aliases let one page answer to multiple names, which powers unlinked-mention detection.

### Recommendations

1. Introduce **human-readable page links**: `[[Page Name]]` resolves to the page with that `display_name` (or name), with disambiguation UI for collisions.
2. Introduce **block references**: `((block-uuid))` syntax and a distinct AST node type.
3. Allow **pages to contain inline links** — remove the `is_page` short-circuit.
4. Add an **alias/synonym** property on pages so unlinked mentions can match "LLM", "large language model", etc.

## 2. Backlinks & Unlinked Mentions

### Notees today

- `GET /nodes/{id}/backlinks` returns explicit `node_link` rows.
- `GET /nodes/{id}/linked-references` is richer: context, breadcrumbs, property provenance.
- A default view `unlinked_references` exists but is implemented as a `ContentCondition` search for the current node name.

### Problems

- The unlinked-references view cannot distinguish "mentions the exact name but is not linked" from "mentions a string that happens to match the name."
- There is no way to **promote an unlinked mention to a real link** in one click.
- Aliases are not considered, so unlinked-mention discovery is brittle.

### What competitors do

- **Obsidian Backlinks pane** has two sections: *Linked mentions* and *Unlinked mentions*. Each unlinked mention can be converted to a link.
- **Roam/Logseq** show unlinked references on the target page and let you link them.
- All three treat aliases/synonyms as part of the mention index.

### Recommendations

1. Build a real **mention index**: after parsing content, scan plain text for known page names + aliases and store candidate mentions separately from explicit links.
2. Expose an endpoint to **convert a mention to a link** (rewrites the source AST, inserts the link node, removes the plain-text occurrence).
3. Allow the user to **ignore false-positive mentions** per page/alias.
4. Surface unlinked mentions in the backlinks panel, not just as a query view.

## 3. Block Embeds / Transclusion

### Notees today

- None. Links point to a target; they do not render the target's content inline.

### What competitors do

- **Roam/Logseq**: `((block-uuid))` is a reference; embed syntax renders the block live and editable.
- **Obsidian**: `![[note]]` or block embeds via `![[note#^block-id]]`.

### Recommendations

1. Add an **embed** ref type (`embed` already exists in the AST but appears unused for block content).
2. Embeds should be **live**: editing the embedded copy edits the original.
3. Track embeds in `node_link` so they show up in backlinks (or a separate embeds panel).

## 4. Graph View

### Notees today

- `GraphView.tsx` fetches links via `POST /nodes/links`.
- Backend returns `reference`, `parent`, `class`, `extends`, `property-reference`, and `cooccurrence` link types.
- The endpoint only sees **page nodes** (`is_page = TRUE`), so block-level references are aggregated to their parent page.

### Problems

- Block-level relationships are **lossy** in the graph.
- Co-occurrence is heuristic and capped at 10 targets per block.

### What competitors do

- Roam's graph is natively block-aware.
- Logseq's graph view can show pages and blocks.
- Obsidian's graph is page/tag-based but dense and filterable.

### Recommendations

1. Add a **block-level graph mode** (toggle or separate view).
2. Use the closure table + `node_link` to render hierarchical edges (`parent → child`) alongside reference edges.
3. Add **local graph view** (1–2 hops from current node), which is more useful than global graph at scale.
4. Allow filtering edges by type and weight (hide weak co-occurrence links).

## 5. Querying & Filtering

### Notees today

- **QueryAST**: visual tree builder with conditions for class, property, content, reference, parent/child, flag, page.
- Compiles to PostgreSQL via `query_ast_sql.py`.
- Placeholders like `{current_node_uuid}` are string-substituted into the AST.
- The `class_path` condition exists in the frontend config but has **no backend entity or SQL generator**.

### What competitors do

- **Roam/Logseq**: Datalog queries. Extremely powerful but steep learning curve.
- **Obsidian**: Dataview plugin uses a SQL-like DSL; simpler but still text-based.
- All three allow power users to write queries as text.

### Problems

- QueryAST is **GUI-only**. Power users cannot copy/paste or version-control queries.
- String-based placeholder substitution is fragile.
- The `class_path` mismatch shows frontend/backend drift.
- No aggregation (count, sum, group by) in QueryAST.

### Recommendations

1. Add a **text query language** that compiles to QueryAST / SQL (a simplified Datalog-like or Dataview-like syntax).
2. Replace string placeholder substitution with typed parameters.
3. Implement `class_path` condition or remove it from the frontend config.
4. Add **aggregation operators** (count, group by) for dashboards.
5. Add **relative date operators** ("today", "last 7 days", "this week") for journal/task queries.

## 6. Tag, Class & Property Filtering

### Notees today

- Tags are `node_link.is_tag = TRUE`.
- Classes are stored in `node.class_ids` with inheritance via `class_extend`.
- Properties have scalar, selection, and relation value tables.
- `ReferenceCondition` ignores inline-class links.

### Problems

- Inline classes are not treated as references in queries, creating an inconsistency.
- Tag links can become orphaned if content is edited but not re-parsed.
- There is no class-level query for "all descendants of this class."

### Recommendations

1. Make `ReferenceCondition` include inline-class links.
2. Add a `ClassPathCondition` (or fix the existing frontend stub) to query "nodes whose class is or inherits from X."
3. Rebuild tag links on every save, not just tag add/remove operations.
4. Consider materializing a `node.search_text` column to avoid `jsonb_path_query` on every content comparison.

## Prioritized Improvement Roadmap

### P0 — Core linking parity

1. Allow pages to contain `[[...]]` links.
2. Introduce human-readable `[[Page Name]]` resolution.
3. Add `((block-uuid))` block-reference syntax.
4. Fix the `class_path` frontend/backend mismatch.

### P1 — Discoverability

5. Build a real unlinked-mentions index using page names + aliases.
6. One-click "link this mention" from backlinks panel.
7. Add aliases/synonyms support for pages.

### P2 — Power features

8. Block embeds / transclusion.
9. Text-based query language compiling to QueryAST.
10. Block-level graph view + local graph mode.
11. Aggregation in QueryAST for dashboards.

### P3 — Quality of life

12. Materialized `search_text` column for performance.
13. ReferenceCondition includes inline classes.
14. Graph edge filtering by type/weight.

## Architectural Observations

The Notees design is well-positioned to support these improvements:

- **AST as source of truth** makes it straightforward to rewrite links in place (for mention-to-link conversion).
- **`node_link` table** is the right primitive for explicit graph edges.
- **Closure table (`node_path`)** already supports fast hierarchy queries.
- **Property/value tables** already support structured filtering.

Main architectural debt to address first:

- Remove the **page-link exception** in `LinkParsingService`.
- Separate **link types** more explicitly in the AST (`page_ref`, `block_ref`, `embed`, `tag`, `class`).
- Move from string-based placeholder substitution to typed parameters in QueryAST execution.
- Introduce a **mention candidate table** separate from `node_link` so unlinked mentions can be tracked, ignored, and promoted.
