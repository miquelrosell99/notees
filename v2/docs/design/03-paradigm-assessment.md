# Notees v2 Knowledge Model — Paradigm Assessment
**vs Obsidian · Logseq 2.0 (DB) · Capacities · Tana — September 2026**

Companion to [knowledge-model](knowledge-model.md) and [model-assessment](model-assessment.md). This document assesses the *documented* Notees v2 model against the four paradigms the owner asked about, using each tool's verified 2026 state. Claims about competitors were checked against current sources on 2026-09-25 (see §12).

---

## 1. The field in 2026 — verified state

| | Obsidian | Logseq 2.0 (DB) | Capacities | Tana |
|---|---|---|---|---|
| **Storage truth** | `.md` files in a folder — the file *is* the database | Local SQLite DB; Markdown demoted to (lossy) export | Cloud objects; offline caching | Cloud, proprietary JSON |
| **Unit** | File | Block (bullet) | Object | Node (bullet, single enforced tree) |
| **Typing** | YAML frontmatter + tags (untyped) | Classes + typed properties in DB | Curated object-type catalog | Supertags with typed fields |
| **Linking** | Untyped `[[wiki]]` | Untyped page/block refs | Untyped object links | Untyped refs + reference *fields* |
| **Queries** | Dataview (JS-ish) · Bases (core, v1.9 Aug 2025) | Datalog (DataScript) | Filtered views; no composable language | Live queries / search nodes |
| **Local-first** | Yes, total | DB: local DB + paid RTC sync (alpha); OG: files | Sync-cached offline | Offline desktop only since Nov 2025 |
| **Agent surface** | Bolted on (plugins, REST-API plugins, MCP guides) | CLI growing; plugin SDK | Minimal | Local API + MCP server (Jan 2026) |
| **2026 headline** | 2,500+ plugins; Bases closed the "no databases" gap without leaving files | 2.0 DB beta shipped 2026-07-13; project split in two (OG vs DB) after a 2-year rewrite | Small VC-free team; object model matured, queries still thin | Supertags + AI command nodes; best-in-class schema-at-capture |

---

## 2. Method

Each tool is assessed on the five lenses that matter for our design decisions: **storage truth** (what is canonical), **unit & identity** (what gets an ID), **structure model** (classes/properties/templates), **discourse model** (how connections are authored), **extensibility** (plugins/agents). Then §7–§11 go cross-cutting: what no competitor does, where they beat us, and what their wounds teach us.

---

## 3. Obsidian — "the file is the truth"

**What it gets right.** Durability and portability are not features but the architecture: a vault is a folder of `.md` files, readable in any editor, grep-able, git-able — which is precisely why it has become *infrastructure for AI retrieval* (any tool that reads files reads your vault). The plugin ecosystem (2,500+) is the deepest in the category. And Bases — database-like views over frontmatter, shipped v1.9 (Aug 2025) — closed the "no databases" gap *without changing the storage truth*: the `.base` file is a view; the file remains the row.

**Its structural ceiling — which is our floor.** Obsidian's metadata cache is file-granular, and its own co-founder says so: Bases rows are files, task/list-item-level structure is "not really useful," nested properties are unsupported, cross-file lookups are single-hop. There is no block identity, no typed entity, no typed edge. The graph is a graph of *files*. Everything semantic is convention (folder taxonomy, naming discipline) or plugin tax (Dataview JS, Templater).

**What we take.** The properties-optional discipline: frontmatter is opt-in, and Obsidian works fully without it — living proof of our "properties are optional by constraint" rule. Also the anti-lock-in argument: we must keep export as a first-class projection for the same reason.

**Where we diverge, and the honest trade.** We trade file-editability for semantic fidelity and convergence: an op log + SQLite projections can do typed edges, block identity, m2m properties, and conflict resolution that files fundamentally cannot. Logseq 2.0 made the *same* trade publicly and paid a trust cost for it (§4) — the lesson is not to avoid the trade but to be brutally honest about it: **in Notees, the log is the truth; Markdown is an export, not a round-trip.** Anyone building on us should never discover that the hard way.

**Validation of our model:** the design law. Obsidian hardened almost nothing into schema; every structure is a convention or a plugin. That permissiveness *is* its moat — the same law our model encodes.

---

## 4. Logseq 2.0 (DB) — the closest ancestor, and the cautionary tale

**Same bets as ours:** outliner editor, block = node, a real database under the graph, classes + typed properties, Datalog queries, local-first instincts. If we needed external validation that our core model is buildable, Logseq DB is it: early testers report DB graphs handling tens of thousands of blocks with less indexing lag than the file version.

**Where it still differs from us:** classes exist but as a separate layer, not nodes in the graph (our v1 mistake, reverted); links are untyped (no discourse verbs — the `contradicts` layer doesn't exist); the edge model has no unified index over mentions + typed links + property values; no two-way link propagation along the tree (its linked-references filtering is the closest thing — our backlinks-facets design is that idea, generalized); sync is a paid alpha (RTC) after years of waiting.

**The three lessons:**
1. **Rewrites are existential.** The DB rewrite was announced April 2024, shipped July 2026, and split the project in two: *Logseq OG* (files, maintenance mode) vs *2.0 DB* (features, beta, "data loss is possible"). Communities tolerate almost anything except storage-truth surprises. Our greenfield exists precisely to take that hit once, deliberately — and to keep the rewrite surface narrow (M1 adds columns, tokens, and an editor; **no new sync primitive**).
2. **Honesty about storage truth is cheaper than hope.** Logseq's docs say the Markdown export "cannot capture all data" and advise automated backups. Being explicit early costs less than walking it back.
3. **Datalog is a power user's gift and a beginner's wall.** We deliberately choose QueryAST→SQL: composable, one grammar, agent-readable, no Lisp.

**Our edge over it:** typed discourse marks (nobody has this), unified node table, propagation semantics, E2EE slot, and a sync core that is *ported and proven* rather than alpha.

---

## 5. Tana — schema-at-capture, done best-in-class

**What it gets right — more than anyone.** The supertag is the single best realization of "schema arrives with the tag": apply `#meeting` to any node and it gains fields *in place* — text, options, dates, numbers, and crucially **reference fields** (node-typed links — our m2o/m2m node-typed properties, validated in production). Live queries, default content per tag (our templates), AI command nodes that act on structured data. The user quote that defines the category: *"I'm not maintaining a system anymore; I'm working inside one that maintains itself."* That is the self-organizing bar our derived-index model is aiming at.

**Where it differs from us, structurally:** one enforced tree — everything is a bullet in one outline (no DAG of classes beside the content tree; classes/supertags are configuration attached to nodes, not nodes); fields are defined on the tag config, separate from the node's content; no typed discourse verbs (reference fields are *attributes*, not verbs in sentences); no inheritance engine exposed the way our `extends` m2m property + derived closure is.

**Its wound — and our differentiation:** cloud, proprietary JSON, export "exists but requires technical effort," offline desktop only since Nov 2025, and a verbatim community complaint: *"Vendor lock-in with my 'second brain' is not acceptable."* Tana proves the demand for exactly our model — typed, self-organizing, agent-accessible (it shipped a Local API + MCP server in Jan 2026, validating the agent-surface bet) — while leaving the durability/privacy/agent-first-from-day-one position wide open. Notees is that position: same capture-time schema power, but local-first, op-logged, E2EE-ready, with scoped agent keys as a first-class surface rather than a January add-on.

---

## 6. Capacities — objects-first, curated catalog

**What it gets right.** The philosophical match for the owner's mental model: *"your brain doesn't think in folders, it thinks in things."* Objects with types (Book, Person, Meeting, Project), per-type properties, backlinks, collections, and the daily note as the primary capture surface. The "Meetings pattern" in our model — a topic page with prose + a query over classed instances — is essentially Capacities' default view of a type. It validates the object-first intuition that pages are *things with entity*, and that capture should happen in daily notes with typing applied as you go.

**Where it differs from us:** the type catalog is **curated by the team** — you pick from their types and tweak; you don't define classes as runtime data with inheritance (`extends`), user-defined property schemas, and a registry. Queries are filtered views, not a composable language. There is no block model (objects have content; content isn't a first-class node graph). Agent surface is minimal. Durability model is cloud sync from a small VC-free team — a real bus-factor consideration for a lifetime archive.

**What we take:** the object-first mental model as *default UX* (recents, favorites, link dropdown ranking pages first) and daily-note capture — while our design law keeps the catalog user-defined rather than curated, because a curated catalog is a usage prediction hardened into product.

---

## 7. The five bets no competitor makes

| # | Bet | Obsidian | Logseq DB | Capacities | Tana |
|---|---|---|---|---|---|
| 1 | **Op log as sole authority** — event-sourced, local-first, E2EE slot, total offline | files only | DB + alpha RTC | cloud cache | cloud cache |
| 2 | **Unified node table — classes are nodes**, tree-external, inheritance as m2m property | no classes | classes, separate layer | curated catalog | supertags as config |
| 3 | **Typed discourse links as marks on prose words** (`contradicts` as a verb you wrote) | — | — | — | — |
| 4 | **Two-way link propagation** along containment (backlink roll-up + refset inheritance) | — | partial (linked-refs filter) | — | — |
| 5 | **Agent-first surface** — scoped keys, one grammar, CLI/API/objects from M1 | plugins | CLI growing | minimal | MCP (2026-01) |

Bet 3 is the most distinctive: every competitor separates *attributes* (properties/fields) from *links*, and leaves **verbs in sentences** — the actual discourse moves of thinking — untyped. That is the layer our typed-link marks capture, and it is unclaimed territory in all four paradigms. Bet 4 generalizes Logseq's best idea (filtering linked references) into a tree-recursive semantic (`refset(n) = own_links ∪ refset(parent)`), which none of them formalize.

---

## 8. Where they beat us — honestly

- **Day-one polish and reliability:** all four are shippable products; we are a spec. Obsidian and Capacities are *boring reliable*, which is a feature.
- **Ecosystem gravity:** Obsidian's 2,500 plugins mean almost any need is already solved. We will not catch that for years, so our plugin story must be capability-brokered and safe from day one.
- **AI features today:** Tana's multi-model AI + command nodes and Capacities' assistant exist now; ours is an agent surface, not a built-in model UX.
- **Mobile and collaboration:** all four have real mobile apps; RTC collaboration exists in-market (Notion-shaped). Our M3 list admits this.
- **Proven scale:** Logseq DB's tens-of-thousands-of-blocks and Obsidian's million-user vaults are tested; our scale rests on the S2 spike.

**The asymmetry to keep in mind:** their advantages are *day-one*; ours (semantic fidelity of typed discourse, durability + privacy, agent surface, migration-free evolution via registry data instead of schema migrations) compound *over years*. The bet only pays if we survive the day-one gap — which is why M1 is narrow and ports proven machinery.

---

## 9. Validation map — who already proved our decisions

| Our decision | Precedent |
|---|---|
| Outliner, block = node | Logseq, Tana, Roam lineage |
| Classes + typed properties at runtime | Logseq DB (in production), Tana supertags (best-in-class) |
| Node-typed properties (m2o/m2m) | Tana reference fields |
| Capture-time schema ("create-and-bind") | Tana supertag gesture |
| Properties optional; content works without them | Obsidian frontmatter discipline |
| Templates / default content | Tana default content, Obsidian Templater |
| Backlinks facets over references | Logseq linked-references filtering |
| Agent demand is real | Tana MCP/Local API (Jan 2026), Obsidian-as-AI-infrastructure guides |
| Don't split classes from the graph | Logseq DB kept them separate — and is the weaker for addressability (our v1 post-mortem, external rhyme) |
| Design law (predictions as defaults) | Obsidian's entire architecture |

---

## 10. Their wounds → our rules

| Their wound | Our rule |
|---|---|
| Logseq's 2-year rewrite split its community | Greenfield once, deliberately; M1 adds no new sync primitive |
| Logseq users felt betrayed by DB-as-truth | State storage truth in the header of every doc: **log is truth, export is projection** |
| Logseq sync arrived late and alpha | Sync core ported + blocking acceptance gate, not a parallel track |
| Tana community: "vendor lock-in with my second brain" | Local-first op log + E2EE slot + first-class export |
| Obsidian's plugin tax (maintenance time, JS in notes) | Capability-brokered plugins; core flows never depend on plugins |
| Obsidian Bases can't reach task/block granularity | Block identity from day one (never a file-granular cache) |
| Capacities curated catalog = team bottleneck | User-defined classes/schemas as runtime registry data |

---

## 11. Bottom line

The four paradigms partition the design space, and Notees v2 sits at their intersection with one addition:

- From **Obsidian**: permissiveness as architecture (the design law), durability instincts, properties-optional.
- From **Logseq**: the outliner, block identity, DB-backed graph — and the rewrite/storage-truth lessons.
- From **Tana**: schema-at-capture, reference fields, the self-organizing ideal, agent demand.
- From **Capacities**: object-first mental model, daily-note capture.
- **Unclaimed by all four:** typed discourse verbs living on the words you wrote, one unified edge index over mentions + verbs + properties, tree-recursive link propagation, and an op-logged local-first core with an E2EE slot.

No competitor invalidates any settled decision. The residual risks the field *confirms* are the ones our confidence ledger already carries: typed-link capture friction (the make-or-break gesture), outliner long-form feel, and scale (S2 spike). Their day-one polish gap is real but is a product-execution matter, not a model matter — the model itself is, on this evidence, the strongest synthesis available in 2026.

---

## 12. Sources (verified 2026-09-25)

- Logseq 2.0 DB split & beta: [Taskade Logseq comparison](https://www.taskade.com/compare/free-logseq-alternative), [Acres vs Logseq](https://getacres.app/compare/acres-vs-logseq/), [Logseq forum — What's new, May 2026](https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020)
- Tana: [Vantaige Tana review](https://vantaige.io/ai-tool/tana), [AI Productivity Tana guide](https://aiproductivity.ai/guides/tana)
- Capacities: [Saner.ai Capacities review](https://www.saner.ai/blogs/capacities-review)
- Obsidian (Bases v1.9, plugins, properties): [ClickUp Obsidian review](https://clickup.com/learn/topic/productivity/tools/obsidian/), [Neura Market Obsidian guide](https://www.neura.market/ai-agents/resources/guides/obsidian-guide), [Sébastien Dubois on Dataview/Bases](https://www.dsebastien.net/the-complete-guide-to-dataview-in-obsidian/)

---

## 13. Feature comparison matrix & copy-list (for the design plan)

### 13.1 Comparison matrix

| Feature | **Notees v2** | Obsidian | Logseq 2.0 DB | Capacities | Tana |
|---|:---:|:---:|:---:|:---:|:---:|
| Storage truth | op log → SQLite projections | `.md` files | local SQLite (MD = lossy export) | cloud objects | cloud JSON |
| Unit / identity | UUIDv7 node (block = node) | file path | block UUID | server-side object id | bullet node |
| Editor | Logseq-style outliner | document | outliner | document-ish | outliner |
| Block-level identity & refs | ✅ full node citizenship | ❌ file-granular only | ✅ | ❌ | ✅ |
| Classes / typing | user-defined classes as **nodes**, runtime registry | ❌ (tags only) | ✅ classes + properties | ✅ curated catalog | ✅ supertags + fields |
| Class inheritance | ✅ `extends` m2m property, derived closure | ❌ | partial (tag hierarchy) | ❌ | partial (tag extends) |
| Node-typed properties (m2o/m2m) | ✅ | ❌ (flat YAML) | ✅ | ✅ | ✅ reference fields |
| Properties optional by design | ✅ core flows independent | ✅ (frontmatter opt-in) | ~ | ~ | ~ (fields on tags) |
| Templates / default content | ✅ template nodes | via Templater plugin | ✅ | ✅ | ✅ default content |
| Untyped links / mentions | ✅ | ✅ `[[wiki]]` | ✅ | ✅ | ✅ |
| **Typed discourse links (verbs on words)** | ✅ **marks on prose** | ❌ | ❌ | ❌ | ❌ |
| Unified edge index (mentions + verbs + properties) | ✅ one derived index | ❌ | ❌ | ❌ | ❌ |
| Backlink roll-up to ancestors | ✅ | ❌ | ❌ | ❌ | ❌ |
| Inherited-link filtering (`refset`) | ✅ recursive + backlink facets | ❌ | partial (linked-refs filter) | ❌ | ❌ |
| Query language | QueryAST → SQL, one grammar | Dataview JS / Bases | Datalog | filtered views only | live queries |
| Local-first / total offline | ✅ op log, designed for it | ✅ | ✅ DB local (sync paid alpha) | sync-cached | offline only since 11/2025 |
| E2EE | ✅ slot in protocol (M3) | via Sync tier | encrypted graphs | ❌ | ❌ |
| Sync / collab | ported op-log sync; CRDT text | file sync (conflict copies) | RTC alpha, paid | cloud sync | cloud sync |
| Agent surface | ✅ first-class: API + CLI + scoped keys | bolt-on plugins | CLI growing | minimal | MCP/Local API (01/2026) |
| Plugin ecosystem | planned (capability-brokered) | ✅ 2,500+ | moderate | minimal | minimal |
| Built-in AI | agent surface, no bundled model | plugins | agent skill emerging | assistant (Pro, daily limits) | ✅ command nodes, multi-model |
| Mobile | on the roadmap (M-tier) | ✅ | alpha (DB) | ✅ | capture-focused |
| Export | first-class projection (MD/BibTeX/CSL) | n/a (files *are* the data) | MD export "not sole backup" | export | JSON, effortful |

### 13.2 Copy-list

**From Obsidian**
1. **Permissiveness as architecture** — nothing structural is ever a prohibition; conventions and views do the work (already our design law — copy their *discipline*).
2. **Properties-optional UX** — the app is fully usable with zero frontmatter; structure is an upgrade path, not a toll gate.
3. **Bases pattern** — database views defined as *view files* over the data, not schema changes; editable cells.
4. **Export = dignity** — first-class, always-current projections because the community audits them.
5. **Boring reliability** as an explicit product value.

**From Logseq 2.0 DB**
1. **The outliner feel** — indent/outdent, zoom into a bullet, collapse states; their interaction model is the target for our editor.
2. **Linked-references filtering** — backlinks panel narrowed by additional refs; we generalize it to `refset` facets (copy the UX, extend the semantics).
3. **CLI breadth** — manage tasks, inspect nodes, search, backup from the terminal; the CLI is a peer of the UI.
4. **Block embeds / transclusion** — edit the embedded copy, the original updates.
5. **The honesty lesson** — say "log is truth, Markdown is export" *before* users ask; it cost them a community split.

**From Tana**
1. **Schema-at-capture gesture** — the tag arrives with the fields; create-and-bind when the schema doesn't exist yet (our single most important UX borrow).
2. **Reference fields** — node-typed properties done right: pick a target from a picker, render as a chip, backlinks automatically.
3. **Default content per class** — new meeting spawns Attendees/Agenda/Action-items automatically (our `has-template`).
4. **Live queries as first-class citizens** — a query is an object you pin, name, and live inside, not a dialog you run.
5. **"Works inside a system that maintains itself"** — the product bar: the graph self-organizes; the user never files anything manually.

**From Capacities**
1. **Object-first chrome** — recents, favorites, type-colored objects, link dropdown ranking important objects first (our page-priority ranking).
2. **Daily note as the front door** — capture starts in today; typing is applied inline as you write.
3. **The Meetings pattern as a default view** — a type's home shows config + a live query over instances out of the box.
4. **Gentle onboarding into objects** — introduce typing progressively; never force a structural decision at capture time.
5. **Small-team focus as a virtue** — depth for solo knowledge workers over breadth for teams.
