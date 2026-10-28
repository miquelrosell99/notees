# The research workflow

Notees ships machinery — a source library with resolver and citekeys, typed-link verb marks, live embeds, backlinks, a query language, first-class export — but no method. This page teaches one disciplined pipeline over that machinery, adapted from the method Atelier (atelierworkspace.com) teaches its researchers. Everything here is **convention over shipped features**: defaults and checks, never a required sequence. The design law applies throughout — predictions become defaults, never prohibitions.

The starter vocabulary this page uses (rationale properties, the `engagement` select, the `synthesis` / `open-question` / `comparison` / `writing-plan` / `concept` classes, the epistemic verbs) is **documented convention, not seeds**: the normative list lives in [SCHEMA.md](../../packages/protocol/SCHEMA.md) ("Starter vocabulary"), you create the pieces you want with the names you want, and nothing here appears in any picker by decree.

## The pipeline

**1. The inquiry.** A research project is a page whose title IS the question. Give it a `guidingInquiry` node-backed text property (why this question, what would count as an answer) and a scope-limit block naming what the project deliberately excludes. Query scopes over the page's subtree bake "the project" into every saved view — the compile-time subtree scope ([queries.md](queries.md)) means a query written inside the project stays inside the project.

**2. Sources with rationales.** Add sources through the library flow ([sources.md](sources.md)); the resolver and citekeys handle the bibliography. The discipline is the rationale, kept in three distinct properties scoped to the source family: `whyItBelongs` (why you selected it — the selection moment), `readingPurpose` (what you're reading FOR), `whatItContributed` (what you took from it — the learning moment). These are three different moments of a project; blending them into one note loses the value. The `engagement` select (`encountered` / `engaged` / `extracted` / `integrated`) is a descriptive self-report of where a source stands — never a quality ranking, never a required progression.

**3. Located notes.** A source's notes are ordinary child blocks under the source node — full grammar, backlinks, focused view, nothing special to build ([sources.md](sources.md)). The discipline: separate quotation from interpretation. Quote verbatim (the `quote` token, or a clear convention of your own); interpret in your own words beneath it. A note cites where the material sits: typed-link marks carry a `locator` in token metadata, and a locator is only worth recording if a reader can use it — a page number that exists, a section heading, a timestamp. Locators must be real: a PDF viewer's page numbers can differ from the printed pagination, so check before you write one. (The locator field ships today; manual paste. In-editor `cites` capture and a PDF reader are designed, not built — [feature-status.md](../feature-status.md).)

**4. Comparison.** When sources disagree, compare them deliberately: one `comparison`-classed node per comparison, embedding the compared sources (or their key notes) so the evidence lives beside the claim. The analytical work is the **consequential difference** block: don't just note that A and B disagree — explain the disagreement through methods, definitions, or populations, because that explanation is usually where the next question lives. A blank field in your comparison is not a literature gap: unread and not-addressed look identical in a table and are completely different facts. Say which one you mean.

**5. Synthesis.** A `synthesis`-classed node with the `move` select naming the analytical move — `pattern`, `tension`, `gap`, `emerging claim`. The move names what you're doing; it does not certify the argument. Evidence is **live embeds** of source notes: the embed renders the real subtree, so a corrected note heals every synthesis that embeds it, and the backlink direction shows you which syntheses rest on which notes. Never copy a quotation into a synthesis and call it evidence — a copy you can't trace is a claim without support.

**6. Open questions.** An `open-question`-classed node with the `status` select — `still open`, `partly addressed`, `in preparation`, `set aside`. The statuses are a map of attention, not a work pipeline. "In preparation" is satisfied structurally: embed the question (or link it) from a writing plan, and the question knows where it's being worked on. A saved board or list view per status ([views.md](views.md)) is the review surface.

**7. The writing plan.** A `writing-plan`-classed page carries three things: an embeds section of the chosen material (syntheses, notes, concepts — live, so the plan never drifts from the research), three node-backed text properties — `workingPosition` (the argument as it stands), `complication` (the strongest counterpressure or gap), `unresolved` (what you still owe the reader) — and a detailed outline child. Export when the plan is ready ([exporting.md](exporting.md)); the embeds mean the exported document reflects the graph as it is now, not as it was when you copied quotes into a file.

**8. Review.** Periodically — per project milestone, or in a weekly journal page — write the review: what the strongest complication turned out to be, and the next move. One rule worth keeping verbatim: **if the next move is only "find more sources", name what missing evidence the search addresses.** A search for "more" is avoidance; a search for "a population study post-2015" is a plan.

## The checks

The pipeline's value is in five checks. Each is a paragraph, not a feature — nothing in Notees enforces them.

- **Consequential difference.** When two sources disagree, the disagreement is data. Explain it via methods, definitions, or populations before you decide who to believe — the explanation is where the research question sharpens.
- **Blank ≠ gap.** A blank cell in a comparison means unread or not-addressed; only the second is a literature gap. Mark the difference explicitly or your gap analysis is fiction.
- **The single-source removal test.** If removing one source from a synthesis would change nothing, that source is background, not evidence. Background belongs in the reading list, not the evidence set.
- **Locators must be real.** A locator a reader cannot resolve is worse than none — it certifies a check nobody performed. Verify against the actual pagination before writing it.
- **Evidence vs. background.** Evidence is what a claim rests on and must be traceable (a live embed, a named source, a locator). Background is what you read to get there. The test is the removal test above.

## Choosing an export

The log is the truth; an export is a projection that leaves the building ([philosophy.md](../philosophy.md)). Choose by purpose:

| Purpose | Format | Notes |
|---|---|---|
| Readable dossier (send, print, submit) | Markdown, Word, LaTeX, PDF ([exporting.md](exporting.md)) | The `academic` layout and LaTeX `thebibliography` derive from source-classed nodes — citations ride the export. |
| Restorable archive (keep, move, back up) | JSON archive, workspace zip ([exporting.md](exporting.md)) | The closest export gets to the log itself; the only formats that carry structure, not just rendering. |
| Reviewable comparison (scan, sort, diff) | CSV from a table view; .bib / CSL-JSON from the Sources hub | Table views download their current rows as CSV; the hub exports the filtered bibliography set. |

## Starter templates

The two templates below are recipes — build each once in your workspace (the template system is [templates.md](templates.md); `has-template` binds them to their classes). As class-bound templates they ride every create-with-template surface.

**Writing plan.** Create a `writing-plan` class, then a template node classed `template`, bound to the class via the class's Templates section. The template body: a heading "Chosen material" with a placeholder line for embeds; three node-backed text properties on the class — `workingPosition`, `complication`, `unresolved`; a "Detailed outline" heading with one starter child block. Variables: `{{name}}` for the working title.

**Comparison.** Create a `comparison` class, then a template bound to it. The template body: a "Question" heading with one starter block; a "Sources" section for embeds; a "Consequential difference" heading with one starter block; a "Blank vs. not-addressed" heading reminding you of the distinction.

## AI assistance — the stance

Assistance, when it comes, will be: **opt-in per workspace, bounded per action, previewed before anything is sent, and disclosed afterward.** No AI feature ships as a load-bearing dependency of this workflow — the deterministic pipeline above is the baseline every assistance feature must leave inspectable. The disclosure substrate already exists: every op on the log carries actor and HLC timestamp, so "what did the AI touch" is a query over provenance, not a separate history to maintain. The capability itself waits for the plugin runtime ([plugins.md](plugins.md)).

## What Notees deliberately doesn't do

- **No seeded research profiles.** Your discipline's vocabulary is yours to create — classes and property schemas are runtime data, and a seeded profile is a usage prediction hardened into schema.
- **No progression enforcement.** The `engagement` and `status` selects describe; they never gate a write, block a link, or order a picker.
- **No completion scores, no reading-session tracking, no grading.** Activity is not knowledge, and Notees does not measure the graph.
- **No mandated workflow.** A visible path is material for discussion; it is not proof of completeness. Every check on this page is yours to keep, bend, or ignore — the graph keeps no score.
