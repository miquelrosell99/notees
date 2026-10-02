# Notees philosophy

The ideas under Notees v2, stated plainly. Every claim here traces to the normative design stack ([.plans/design/01-knowledge-model.md](../.plans/design/01-knowledge-model.md), [.plans/design/03-paradigm-assessment.md](../.plans/design/03-paradigm-assessment.md), [packages/protocol/SCHEMA.md](../packages/protocol/SCHEMA.md)) — this document is the readable version, not a new authority.

## The operation log is the only authority

Notees is event-sourced. Every mutation — create a page, move a block, set a property, delete a node — is an op: an append-only envelope with actor, HLC timestamp, and provenance. The op log is the truth. Everything else — the SQLite store behind every view, the edge index, the search index, the node stats — is a **derived projection** that the applier maintains and that can be wiped and rebuilt by replaying the log. Wipe, replay, identical. That property is a hard requirement, not an aspiration.

Two consequences matter for you:

**Export is a projection, not a round-trip.** Markdown (or BibTeX, or CSL-JSON) is a rendering of the graph, as faithful as we can make it — and it will never be the storage. We state this in the header of the document rather than let you discover it: Logseq's community split over exactly this surprise, and their own docs admit the Markdown export "cannot capture all data." In Notees there is no such discovery to make. The log is the truth; export is how the truth leaves the building.

**Honesty about storage truth is a rule, not a vibe.** Anyone building on us — a plugin, an agent, a future you with `sqlite3` and a Sunday afternoon — should never have to reverse-engineer what is canonical. Semantic state lives only in the log; anything a client keeps locally that is not semantic (see *Semantic state vs device state* below) is explicitly client-local and never synced.

## The design law: predictions become defaults, never prohibitions

> **Encode usage predictions as defaults, linter rules, and generated views — never as schema prohibitions.**

A prediction encoded as a default, when wrong, costs an empty list. The same prediction hardened into a prohibition, when wrong, costs a parallel mechanism, a migration, or an identity break. Defaults are cheap to be wrong about; prohibitions are expensive. So Notees ships almost no "you may not."

### The worked example: the seeded vocabulary that wasn't

The model has a natural home for epistemic wiring — typed-link verbs like `supports`, `contradicts`, `refines` (see [ux.md](ux.md) for how typed links work). Early in the design, the proposal was to seed these as protocol-level vocabulary: predefined verb types shipped in the picker.

The proposal was caught before it shipped, and the reasoning is the law in miniature. Seeding `supports`/`contradicts`/`refines` is a usage prediction — "these are the discourse moves our users will make" — hardened into the protocol layer. If the prediction is right, a seed saves the user a one-time gesture. If it is wrong — and v1's own history says it will be, eventually — a protocol seed costs a deprecation cycle at best and a fork of the vocabulary at worst. The cost asymmetry is the whole argument: an unseeded vocabulary that users create as needed costs nothing when the prediction fails; a seeded one costs real structure.

So the epistemic vocabulary is **documented convention, not protocol seeds**: starter property schemas users may create, listed in the model doc, absent from the picker by decree. Same model power, zero hardening.

v1 supplied the cautionary versions: a `CHECK` constraint enforcing the page/block doctrine, set-only classes, content-less classes — each a reasonable forecast frozen into schema, each expired and paid for. The seeded-vocabulary proposal was the same pattern about to repeat one layer up. The design law exists so the pattern gets caught every time, not just the times someone is paying attention.

The same law, stated as a meta-layer test: **if uniformizing X requires a parallel attribute system for it, X is configuration, not an entity.** Classes pass (their lifecycle happens in your mind); property schemas fail (`isbn` is vocabulary for forms and the query compiler — addressable and user-definable, but not a graph citizen).

## Single-sourcing, and schemas that make drift unrepresentable

Drift between two representations of the same fact is a design smell Notees refuses by construction. Four mechanisms enforce it:

**Two booleans for structure.** Identity and rendering are one bit each — `is_class` marks a node as a class, `present_as_main` says a parented node renders in its parent's Pages zone with document chrome rather than inline in the body with block chrome — over a single placement `CHECK` (a class is always a root). "Page" and "block" are render states of one kind of node, not stored kinds, and the render bit never writes on a move, so no flag can disagree with placement: moving a child between parents updates one parent edge — no cascades, no second record of where anything lives. Illegal states are unrepresentable, not guarded.

**No shadow registries.** The list of classes is a derived read model keyed on `is_class = 1` — computed from the node table, never a stored registry that could diverge from it. One mechanism, and the authority is the node.

**One mechanism, two uses.** Which children render in a page's body is a single derived rule with two outcomes: carriers of the page's node-typed properties render in the properties panel; child pages render in a dedicated child-pages section. Everything else — classed children included — renders in the body. Both are the applier recomputing the same classification — never stored flags that could drift from the tree.

**One write path.** Content is a flat token stream, and every token — text, mentions, typed-link marks, quotes, queries, whiteboards, assets, embeds — rides the same `object.create`/`object.update` ops. No token type introduces a new op or sync primitive. Adding a content capability never forks the write path, which means the sync machinery — the most expensive thing in the system to get wrong — never grows.

## Classes are nodes

A class is a node: addressable, linkable, annotatable, with provenance, in the same table as the things it classifies. It is also *for* configuration — property bindings, inheritance, templates — and nothing about being configuration requires a separate table. v1 had the split and reverted it.

What this buys you:

- **Inheritance is data.** `extends` is an m2m node-typed property between class nodes; multiple inheritance from the start, diamonds natural, cycles rejected fail-loud. The transitive closure is derived. A `project` that extends `task` appears in both class lists and inherits `task`'s property bindings — effective membership is own classes ∪ ancestors, with a deterministic binding-resolution order (own binding → shortest extends-path → earliest-authored).
- **Classes live in the graph you already navigate.** You can mention a class, write prose about it, link to it — because it is a node. The "Meetings" pattern is the canonical shape: a topic page carries prose and embeds a query over nodes classed `meeting`, while the class page itself shows configuration plus its members.
- **Deletion is honest.** Delete a class and its instances keep their `class_ids` entry, rendered raw. Nothing cascades into your content.
- **Declaration is cheap.** Declare a class by creating the node with the class identity (`class.create`): the node becomes a root with Class View and configuration. Classes are created, configured, and used later — or never. (Projection defaults exclude class nodes from content views like recents and the tree; that is a view choice, not a schema rule.)

## What-it-is lives in class; data lives in tokens

The whiteboard is the worked example. A whiteboard is not a new node kind, a flag, or a special table. A whiteboard is **a node classed `whiteboard`** — the what-it-is axis — whose geometry lives in a `whiteboard` content token: shapes, strokes, connectors, and per-card `x, y, w, h` keyed by node id.

The cards on a whiteboard are its **child blocks**. Full content grammar, backlinks, search indexing, focused view, classing — everything a block gets, a card gets, because it *is* a block. The tree holds content; the token holds geometry. Dragging a card updates the layout token (debounced, coalesced — no per-mousemove op spam); the content never moves.

The design rule that falls out, stated once and general: **semantic text lives in cards, not shape labels.** A shape label is chrome; text that matters to the graph gets a card. And the enforcement is — per the design law — a lint suggestion, never a prohibition.

The same shape shows up everywhere: what something *is* is always class; the specialized data that kind carries lives in content tokens or assertion rows. Class↔token divergence (a node with whiteboard geometry but no whiteboard class) is a lint suggestion, not an error state.

## Identity is UUID; names are projections

UUIDv7 is the only identity in the system. Titles, citekeys, filenames, paths are attributes — useful, indexed, exportable, and renamable without touching a single incoming link.

Names are resolved, not stored, at every point of use:

- A **mention** stores the target's id and its captured surface form. Rendering resolves the target's *current* name. Rename the target and every mention updates — because mentions never held the name.
- A **class chip** references the class node and renders its current name; rename the class once and every chip follows. (Inserting a chip does not assign the class — chips are render-only; a lint may suggest the assignment.)
- **Blocks derive their display name** from their content (first text runs, one line, truncated), with an optional stored-name override.
- Renames never propagate as writes. There is no rename cascade because there is nothing to cascade to — a name is a projection of the node, recomputed wherever it appears.

Deletion follows the same identity discipline: a tombstone, plus retention (deleted nodes go to trash, with the subtree). The node is gone from every view; its id remains occupied so a stray reference renders as a broken target (the raw id) rather than silently retargeting. Convergence is boring on purpose: LWW by HLC for scalars, OR-Set add-wins for class membership and m2m values, CRDT text only for collaborative editing.

## Semantic state vs device state

Some state is not knowledge, and Notees keeps it out of the log so the log stays meaningful:

- **Semantic state** — anything whose meaning is shared across devices — lives only in the op log. If losing it would lose knowledge, it is semantic.
- **Device state** — whether a PDF is pinned for offline reading, cached, or evicted to save space — is client-local policy, managed by a local engine against `device_asset` rows. It is **never an op and never synced**: your phone's storage pressure is not a fact about your knowledge, and no other device should replay it. Cross-device preferences ride user settings, a separate channel.

The test is one question: *would a second device, given the log, be wrong without this?* Yes → it is semantic → it is an op. No → it is device state → it stays home.

## What we took — and the wounds that became our rules

Notees v2 sits at the intersection of four mature paradigms, with one layer none of them claims ([full assessment](../.plans/design/03-paradigm-assessment.md)):

- **From Obsidian**: permissiveness as architecture — the design law, validated as a moat. Properties-optional discipline: the app is fully usable with zero properties; structure is an upgrade path, not a toll gate. And **export = dignity**: first-class, always-current projections, because a community audits them.
- **From Logseq**: the outliner feel — bullets, zoom, collapse; block identity; the linked-references filtering idea we generalized into tree-recursive `refset` propagation. And the two wounds we treat as law: rewrites are existential (so this greenfield adds columns, tokens, and an editor — no new sync primitive), and storage-truth honesty is cheaper said early than walked back late.
- **From Tana**: schema-at-capture — the tag arrives with the fields, and create-and-bind when the schema doesn't exist yet; reference fields (our node-typed properties); the bar of "working inside a system that maintains itself."
- **From Capacities**: the object-first mental model — recents, favorites, link dropdown ranking objects first; daily-note capture; the Meetings pattern as a default view; gentle, progressive onboarding into typing.

Their wounds, our rules:

| Their wound | Our rule |
|---|---|
| Logseq's 2-year rewrite split its community | Greenfield once, deliberately; the sync core is ported, proven machinery |
| Logseq users felt betrayed by DB-as-truth | State the storage truth in the header of every doc: log is truth, export is projection |
| Logseq sync arrived late and alpha | The ported fixture/convergence corpus is a blocking M1 exit gate, not a nice-to-have |
| Tana community: "vendor lock-in with my second brain" | Local-first op log, E2EE slot, first-class export |
| Obsidian's plugin tax | Core flows never depend on plugins; plugins are capability-brokered (M3) |
| Obsidian Bases can't reach block granularity | Block identity from day one |
| Capacities' curated catalog as team bottleneck | User-defined classes and property schemas as runtime registry data |

Where they still beat us, honestly: day-one polish, ecosystem gravity, built-in AI features, mobile, and proven scale. Their advantages are day-one; ours — semantic fidelity of typed discourse, durability and privacy, the agent surface, and migration-free evolution through registry data instead of schema migrations — compound over years. The bet only pays if we survive the day-one gap, which is why M1 is deliberately narrow.

## Where to next

- [usage.md](usage.md) — what of this you can run today
- [ux.md](ux.md) — how the ideas feel in the interface
- [.plans/design/01-knowledge-model.md](../.plans/design/01-knowledge-model.md) — the normative model statement
- [README.md](../README.md) — the front door
