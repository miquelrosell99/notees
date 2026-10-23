# Templates

Reusable bodies bound to classes: a template is a node, not a new kind — the `template` class says "this node's subtree is a reusable body". Binding is a property edge (the class's **Templates** cards, ＋ Bind template); instantiation is a client-side clone over ordinary single-node ops. The template cards live on the class page ([classes.md](classes.md)); instantiation rides the object-create flows that offer a bound template (the calendar's Tasks New among them, [calendar.md](calendar.md)).

## Binding and provenance

Templates are bound to classes, and the copy opens as a fresh node stamped with a `generated-from` provenance link back to the template. Provenance is one-way: edit the copy freely — nothing writes back to the template — and unbinding a template from a class never touches copies already made. The create surfaces stay unfiltered: one class-filtered picker — the class's own template bind — instead of filter plumbing everywhere; template *choice* happens at the moment of creation, Capacities-style.

## Ways to use a template

- **`/template`** (any block) — type `/template` and pick from the flat list of all templates (the typed remainder filters it — commands match on the first word, the rest is the argument — e.g. `/template meeting`). The pick creates a fresh page instantiated from the template and links it at the caret. A template is usable this way whether or not it is bound to a class.
- **The gallery** — the class page's Templates section → **Browse gallery**: every template in one searchable list, the browse surface with keyboard create-with-template (type to filter, arrows, **Enter** on the highlighted row — or its **Use template** button — creates-with-template and opens the copy; the row click opens the template itself; **＋ New template** authors a new one).
- **Apply to an existing node** — a template card's apply affordance (the class page's Templates section) grafts the template onto a node you pick: its child blocks are cloned beneath, its classes/properties are added, and the `generated-from` stamp is written. Content the node already carries is never overwritten, and a node already generated from that template is skipped (no duplicated blocks).

## Variables

Write `{{name}}` placeholders in a template's text (titles included — a title is text). Instantiating a template that has variables opens a small dialog first: static names are editable rows (leave one empty to substitute nothing), dynamic names — `today`, `time`, `datetime`, `current_page` — are computed at apply time (local time — never UTC) and shown read-only. Everything substitutes locally before the copy is written; a name the dialog never showed is never touched.

Not shipped: a global create-with-template chord (Capacities' Ctrl/Cmd+U analog — the keymap is the App shell's register) — see [search.md](search.md#global-chords) for the chords that do exist.
