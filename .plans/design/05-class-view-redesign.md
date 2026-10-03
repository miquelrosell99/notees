# Class view redesign — a class page is a page (proposal, rev 2, 2026-10-03)

Status: proposal for owner review, **rev 2** (owner direction: render classes with
the normal page view plus extra class-relevant sections — not a bespoke layout).
No wire/protocol change — pure web view-layer (`apps/web`); no client-lockstep
impact (GTK/Flutter class views are separate code).

## Problem

The class view reads as a wall of admin panels while the page view reads as a
document. Root causes, verified against `apps/web/src/ui/ClassView.tsx`:

1. **Config-first ordering.** EXTENDS → EXTENDED BY → TEMPLATES → PROPERTY
   BINDINGS → DESCRIPTION all render before any content; the class's actual
   payload — its instances — sits in a collapsed section at the very bottom.
2. **The Description panel is a literal duplicate.** Title-is-content (owner
   decision 2026-10-01): the title IS the `contentAst`. The panel renders
   `node.contentAst` read-only under a label — in practice it shows the same
   text as the title right above it. (Owner 2026-10-03: drop it.)
3. **Chrome that exists nowhere else.** An always-visible 10-swatch color
   strip, raw `<select>` adders, uppercase boxed panel titles
   (`.nt-class-panel`) — none of these patterns appear in page view, so the
   two surfaces feel unrelated. Classes are containers (Revision 11) and can
   hold child blocks, but the class view renders that body read-only in a
   collapsed section instead of as the page it is.

## Reference patterns (checked 2026-10-03)

- **Capacities** — clicking an object type shows *all objects of that type in
  database format* (their [glossary](https://docs.capacities.io/reference/glossary));
  icon/color/properties live in type *settings* panels, and properties are
  added from a type panel ([object types](https://docs.capacities.io/reference/content-types),
  [object properties](https://docs.capacities.io/reference/object-properties)).
- **Tana** — the supertag *page* defaults to a table of tagged nodes; the full
  configuration (fields, content template, pinned fields, extends, colors)
  lives in a separate [supertag configuration
  panel](https://outliner.tana.inc/learn/features/supertags) behind a wrench /
  Cmd+Shift+Click, never on the page itself. Fields carry *pinned* status that
  promotes them to instance tops and view menus ([fields](https://outliner.tana.inc/learn/features/fields)).

Shared lesson: **instances and content are the page; schema is secondary
chrome.**

## Architecture — ClassView becomes a thin composition over PageView

A class node gets document chrome through the same component a page does.
`App.tsx` routing and the view-routing tests keep rendering `ClassView`; it
stops being a bespoke screen and becomes:

```tsx
export function ClassView({ client, classId, onOpenClass, onOpenPage }) {
  return (
    <PageView
      client={client}
      pageId={classId}
      onOpenPage={onOpenPage}
      corner={<ExtendsPills … />}                       // replaces ClassesRow
      sections={<>
        <ClassedNodesSection … />                      // instances table
        <PropertyDefinitionsSection … />               // the schema editor
        <TemplatesSection … />                         // assigned template cards
      </>}
      systemSections={<>
        <ExtendedBySection … />                        // one lazy Section
        <SystemSections client={client} pageId={classId} … />
      </>}
    />
  );
}
```

`PageView` gains exactly four optional slots (all default to current
behavior, so page rendering is untouched):

- `corner?: ReactNode` — replaces the `.nt-page-classes-corner` `ClassesRow`.
- `sections?: ReactNode` — inserted between the block body and the system
  sections.
- `systemSections?: ReactNode` — replaces the default `<SystemSections/>`.
- `iconButton?: ReactNode` — replaces the header icon picker (classes keep the
  curated `CLASS_ICONS` grid; pages keep the full picker).

Everything else — editable outliner body with dnd, blocks ViewToolbar, tags
row, Properties section, Find/Replace, kebab menu, empty-page "Add a block" —
comes along unchanged. A class's child blocks become its **editable body**,
the thing the current class view buries read-only.

### What class pages render, top → bottom

1. **Header** — class icon (curated picker) + `TitleEditor`; class-color dot
   (see below) in the toolbar row; shared kebab.
2. **Corner: Extends pills** — the *parents* of this class as colored pills
   (`getClassParents`), **not** the page's class pills. × removes a parent,
   ＋ opens the class-only picker (`NodeSelector searchMode="classes"` — the
   picker is scoped to classes only, same population as today's "Add parent
   class" select). Writes go through `setClassExtends`, keeping the loud
   cycle failure; the transient error banner stays. Extends order is
   deterministic, so no drag-sort on these pills.
3. **Body** — the class's child blocks, editable, exactly like a page.
4. **Classed nodes** — the instances: existing `ViewToolbar` (table default
   per owner rule; outline/cards/kanban when a select binding exists) +
   editable table with one column per property binding. `NodeViewSection`
   with a count badge, **expanded by default** — the Capacities database /
   Tana supertag table.
5. **Property definitions** — the schema editor (§below): `NodeViewSection`
   with count, **expanded when empty, collapsed once non-empty** (invites
   setup, then stays out of the way — parity with the page's "Properties N").
6. **Templates** — assigned-template cards (§below), same section treatment.
7. **System sections** — `Extended by` (new lazy `Section`: badge count,
   read-only outline rows over `getClassChildren` that open the subclass) and
   the reused `SystemSections` (Child pages, Linked references, Unlinked
   references — it takes any node id). Empty sections hide themselves.

**Dropped:** the Description panel (title-is-content), the standalone
Extends/Extended-by panels, and the always-visible color strip (replaced by a
single color-dot button in the header toolbar that opens the shared
`ColorPickerRow` popover — same 10 presets, same legacy-hex mapping).

**Detail:** the class's generic Properties table would also list authored
`has-template` rows once Templates has its own section — suppress the
has-template schema row on class pages (the dedicated section is its friendly
face).

## Property definitions UI

Today one `<li>` carries ~12 always-visible controls (number input, name,
type text, filter text, default input, three checkbox labels, precision
select, qualified checkbox, ×). Proposal — Capacities type-panel feel, two
states per binding row:

**Collapsed row (default):**

```
[grip] [type glyph]  Name   [→ Person] [default: X] [day] [⚑] [🔒] [👁]  [⋯] [×]
```

- **Grip** — drag to reorder (dnd vertical, the `ListSortable` idiom), writing
  `sequence` via `setClassProperty`. The raw sequence number input goes away.
- **Type glyph** — one mdi icon per type (text/number/url/email/date/
  date_range/select/object/image/boolean); read-only, title tooltips the type.
- **Name** — inline rename (pencil/double-click) → `updatePropertySchema {name}`.
- **Chips, only when set** — target-class filter as a `→ Person` pill (opens
  the class picker); `default: value` chip; precision as a cycling chip for
  date bindings.
- **Flag toggles** — Required / Readonly / Hide-when-empty as icon buttons
  with active state (⚑ / 🔒 / eye-off), tooltips for the words.
- **⋯** expands the row; **×** removes the binding (`unsetClassProperty`).

**Expanded row:** name field · type + multi badge (read-only, create-time
contract) · target-class filter as pills + `AddPill` · typed default-value
editor · `ToggleSwitch` rows for Required / Readonly / Hide when empty · date:
precision select + dateQualified toggle · object: dateQualified toggle. Inline
expander (not a modal) so several rows can stay open while configuring.

**Add affordance:** `+ Add property` `AddPill` opening a search/create popup
over existing schemas (the `AddPropertyRow` pattern from
`MetadataSection.tsx`) — replacing the raw `<select>`. Creating a schema
binds it immediately.

The list rhymes with the page view's `PropertiesTable` (label left, control
right, token-only CSS), so class pages and pages share a visual grammar.

## Templates UI

Today: text links + × + `AddPill`. Proposal — **assigned template cards**:
one compact card per bound template (`listClassTemplateBindings`): template
icon (effective class icon, fallback `mdi-clipboard-text`), template name,
hover-reveal × (unbind — `unsetProperty(hasTemplate, idx)`), click opens the
template. Cards wrap in a row; `＋ Bind template` `AddPill` at the end keeps
the existing template-class-filtered `NodeSelector` (the ONE class-filtered
surface per the §34.25 amendment). Optional later: card subtitle with the
template's first-block excerpt as a hint.

## Rename ClassPills → NodePills

The component renders node-reference pills generally; with the class view as a
third consumer (extends pills) the class-specific name now misleads. Scope:
`ClassPills.tsx` → `NodePills.tsx`, `ClassPills.css` → `NodePills.css`
(`class-pills__*` → `node-pills__*`), and the two current import sites
(`PageView` header corner, block-row classes column). Behavior unchanged there.

The write path becomes parameterizable — today × hardwires `unassignClass` and
the grip hardwires `reorderClasses`; both become optional props (`onRemove` /
`onReorder`, or an `actions` adapter) defaulting to current behavior. The
class view passes `setClassExtends`-based handlers and disables dragging, so
no new client surface is needed.

## Phasing

- **A — composition:** the four PageView slots; `ClassView` as the thin
  wrapper; Extends corner pills (class-only picker); Extended by + reused
  `SystemSections`; color dot; drop Description. The class body becomes the
  editable page body.
- **B — schema editor:** collapsed/expanded property-definition rows, drag
  reorder, search/create add popup.
- **C — templates:** template cards; suppress the has-template row in the
  class's generic Properties table.
- **D — rename + cleanup:** the `NodePills` rename; retire the
  `.nt-class-panel` CSS block; docs pass (user-facing `docs/ux.md` class
  chrome, `.plans/implementation-plan.md` §34 work-record entry; SCHEMA.md
  untouched — no model/wire change).

## Open questions (owner)

1. Section order after the body — Classed nodes → Property definitions →
   Templates (proposed), or schema before instances?
2. Classed nodes expanded by default (proposed); Property definitions and
   Templates expanded-when-empty / collapsed-once-bound (proposed)?
3. Template-card excerpt subtitle — now or later?
4. Keep the legacy-class-color mapping, or one-time remap the data and drop it?
