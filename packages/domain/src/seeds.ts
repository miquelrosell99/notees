/**
 * System seeds — fixed UUIDs ported from v1
 * (`app/domain/entities/constants.py`, guarded there by
 * `tests/core/test_system_uuid_parity.py`).
 *
 * HARD RULE (Revision 6 precedent): these ids are baked into fixtures,
 * exports, and future migration scripts. Never rename, never regenerate.
 * New system entities append; withdrawn ids are never reused
 * (v1 precedent: `locator` …0018 withdrawn).
 */

export const SYSTEM_CLASS_UUIDS = {
  class: "00000000-0000-0000-0001-000000000001",
  year: "00000000-0000-0000-0001-000000000003",
  month: "00000000-0000-0000-0001-000000000004",
  day: "00000000-0000-0000-0001-000000000005",
  quote: "00000000-0000-0000-0001-000000000006",
  query: "00000000-0000-0000-0001-000000000007",
  code: "00000000-0000-0000-0001-000000000008",
  asset: "00000000-0000-0000-0001-000000000009",
  whiteboard: "00000000-0000-0000-0001-000000000010",
  card: "00000000-0000-0000-0001-000000000011",
  task: "00000000-0000-0000-0001-000000000012",
  template: "00000000-0000-0000-0001-000000000013",
  comment: "00000000-0000-0000-0001-000000000014",
  table: "00000000-0000-0000-0001-000000000015",
  warning: "00000000-0000-0000-0001-000000000016",
  note: "00000000-0000-0000-0001-000000000017",
  tip: "00000000-0000-0000-0001-000000000018",
  info: "00000000-0000-0000-0001-000000000019",
  danger: "00000000-0000-0000-0001-000000000020",
  success: "00000000-0000-0000-0001-000000000021",
  cloze: "00000000-0000-0000-0001-000000000022",
  source: "00000000-0000-0000-0001-000000000023",
  book: "00000000-0000-0000-0001-000000000024",
  paper: "00000000-0000-0000-0001-000000000025",
  article: "00000000-0000-0000-0001-000000000026",
  thesis: "00000000-0000-0000-0001-000000000027",
  document: "00000000-0000-0000-0001-000000000028",
  agent: "00000000-0000-0000-0001-000000000029",
  person: "00000000-0000-0000-0001-000000000030",
  organization: "00000000-0000-0000-0001-000000000031",
  collection: "00000000-0000-0000-0001-000000000032",
  highlight: "00000000-0000-0000-0001-000000000033",
  weblink: "00000000-0000-0000-0001-000000000034",
  movie: "00000000-0000-0000-0001-000000000035",
  song: "00000000-0000-0000-0001-000000000036",
  tv_series: "00000000-0000-0000-0001-000000000037",
  conference: "00000000-0000-0000-0001-000000000038",
  // §34.36 meeting system (owner ruling 2026-10-04: plain seeds — zero wire
  // cost, seed convergence only).
  meeting: "00000000-0000-0000-0001-000000000039",
  // §34.36 RESHAPE (owner directive 2026-10-04): `event` is the CALENDAR
  // family root — the date-only base class the calendar story builds on;
  // `meeting` extends it (SYSTEM_CLASS_EXTENDS below), so disabling event
  // disables meetings with it, not vice versa.
  event: "00000000-0000-0000-0001-000000000040",
  // §34.36.3 (owner directive 2026-10-04): `birthday` extends `event` — a
  // person's birthday is an event on the calendar (eventDate drives the chip
  // via the birthday binding row seeded in SYSTEM_EXTRA_CLASS_BINDINGS); the
  // family itself is person-typed (birthdayPerson), not a date duplicate.
  birthday: "00000000-0000-0000-0001-000000000041",
  // …0042 WITHDRAWN 2026-10-04 (same day it was minted): the `cover` system
  // class duplicated the cover PROPERTY's meaning (owner directive — a cover
  // is an ordinary ASSET-classed node; the property value stays the only
  // authority, the card-view badge derives from it). Never reuse.
  // §34.99 (#14 follow-up): the deploy catalog's missing everyday classes
  // (owner list: definition, idea, place, project, trip) — plain seeds per
  // the §34.36 ruling (zero wire cost, seed convergence only). trip extends
  // event (a trip is calendar-bound; the events toggle cascades to it).
  definition: "00000000-0000-0000-0001-000000000043",
  idea: "00000000-0000-0000-0001-000000000044",
  place: "00000000-0000-0000-0001-000000000045",
  project: "00000000-0000-0000-0001-000000000046",
  trip: "00000000-0000-0000-0001-000000000047",
} as const;

export type SystemClassName = keyof typeof SYSTEM_CLASS_UUIDS;

export const SYSTEM_CLASS_ICONS: Record<SystemClassName, string> = {
  class: "mdiTagMultiple",
  day: "mdiCalendarToday",
  month: "mdiCalendarMonth",
  year: "mdiCalendarText",
  quote: "mdiFormatQuoteClose",
  query: "mdiMagnify",
  code: "mdiCodeTags",
  asset: "mdiPaperclip",
  whiteboard: "mdiDraw",
  card: "mdiCardOutline",
  task: "mdiCheckboxMarkedCircleOutline",
  template: "mdiFileDocumentOutline",
  comment: "mdiCommentOutline",
  table: "mdiTable",
  warning: "mdiAlert",
  note: "mdiNoteOutline",
  tip: "mdiLightbulbOutline",
  info: "mdiInformationOutline",
  danger: "mdiAlertCircle",
  success: "mdiCheckCircle",
  cloze: "mdiEyeOff",
  source: "mdiBookshelf",
  book: "mdiBookOpenVariant",
  paper: "mdiNewspaperVariantOutline",
  article: "mdiNewspaper",
  thesis: "mdiSchoolOutline",
  document: "mdiFileOutline",
  agent: "mdiAccountGroupOutline",
  person: "mdiAccountOutline",
  organization: "mdiDomain",
  collection: "mdiFolderMultipleOutline",
  highlight: "mdiFormatHighlight",
  weblink: "mdiLinkVariant",
  movie: "mdiMovieOpenOutline",
  song: "mdiMusicNote",
  tv_series: "mdiTelevisionClassic",
  conference: "mdiPresentation",
  meeting: "mdiCalendarClock",
  event: "mdiCalendar",
  birthday: "mdiCakeVariant",
  definition: "mdiBookOpenPageVariant",
  idea: "mdiThoughtBubbleOutline",
  place: "mdiMapMarkerOutline",
  project: "mdiBriefcaseOutline",
  trip: "mdiAirplane",
};

/**
 * System class DISPLAY names (owner directive 2026-10-05: normal wording —
 * "TV series", not "tv_series"). The seed keys stay camelCase/snake_case
 * forever (fixed vocabulary, code-facing); these are the human titles the
 * seeds and self-heals author into class nodes' text content (title-is-
 * content) so every surface (class picker, quick-create, calendar chips,
 * Class View) reads normal wording. Title Case for classes; conventional
 * spellings for acronyms/compounds ("TV series", "Web link"). Live
 * workspaces seeded with the raw keys are renamed by the one-time
 * scripts/migrate-system-names.mts pass. One entry per SYSTEM_CLASS_UUIDS
 * key — the domain test pins completeness.
 */
export const SYSTEM_CLASS_DISPLAY_NAMES: Record<SystemClassName, string> = {
  class: "Class",
  year: "Year",
  month: "Month",
  day: "Day",
  quote: "Quote",
  query: "Query",
  code: "Code",
  asset: "Asset",
  whiteboard: "Whiteboard",
  card: "Card",
  task: "Task",
  template: "Template",
  comment: "Comment",
  table: "Table",
  warning: "Warning",
  note: "Note",
  tip: "Tip",
  info: "Info",
  danger: "Danger",
  success: "Success",
  cloze: "Cloze",
  source: "Source",
  book: "Book",
  paper: "Paper",
  article: "Article",
  thesis: "Thesis",
  document: "Document",
  agent: "Agent",
  person: "Person",
  organization: "Organization",
  collection: "Collection",
  highlight: "Highlight",
  weblink: "Web link",
  movie: "Movie",
  song: "Song",
  tv_series: "TV series",
  conference: "Conference",
  meeting: "Meeting",
  event: "Event",
  birthday: "Birthday",
  definition: "Definition",
  idea: "Idea",
  place: "Place",
  project: "Project",
  trip: "Trip",
};

/** The class title a seed/self-heal authors for `name` (display wording). */
export function systemClassDisplayName(name: SystemClassName): string {
  return SYSTEM_CLASS_DISPLAY_NAMES[name];
}

/** Canonical `extends` edges between system classes (multiple inheritance-ready). */
export const SYSTEM_CLASS_EXTENDS: Partial<Record<SystemClassName, SystemClassName[]>> = {
  book: ["source"],
  paper: ["source"],
  article: ["source"],
  thesis: ["source"],
  document: ["source"],
  movie: ["source"],
  song: ["source"],
  tv_series: ["source"],
  conference: ["source"],
  person: ["agent"],
  organization: ["agent"],
  // §34.36 reshape (owner directive 2026-10-04): meeting IS-A event — the
  // calendar family root. meeting's own family (meetingDate/location/agenda)
  // stays meeting-specific on top of the event date.
  meeting: ["event"],
  // §34.36.3: a birthday IS an event (a person's birthday lands on the
  // calendar through the event chain, exactly like a meeting).
  birthday: ["event"],
  // §34.99 (#14 follow-up): a trip IS an event — calendar-bound, so the
  // events-family toggle cascades to it (SYSTEM_CLASS_EXTENDS is the
  // cascade authority, §34.55 F1–F4).
  trip: ["event"],
};

/**
 * §34.36 reshape — the future Features tab's gating semantics, encoded as a
 * read over the extends map (the tab itself is another surface): disabling a
 * class disables its extends-CHILDREN with it (disabling `event` hides
 * `meeting`), while disabling a child alone leaves the parent live
 * (disabling `meeting` leaves `event` and its chrome). Returns the
 * transitive ancestor set; a class is gated when itself or any ancestor is
 * feature-off.
 */
export function systemClassAncestors(name: SystemClassName): ReadonlySet<SystemClassName> {
  const ancestors = new Set<SystemClassName>();
  const stack = [...(SYSTEM_CLASS_EXTENDS[name] ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    stack.push(...(SYSTEM_CLASS_EXTENDS[current] ?? []));
  }
  return ancestors;
}

// §34.81 (owner 2026-10-05): the scratchpad page is WITHDRAWN — "not wanted
// for notees". It is no longer seeded and its UUID is never reused;
// workspaces seeded before the withdrawal still carry the page, so the
// workspace zip keeps excluding it as legacy scaffolding (routes-auth).
export const LEGACY_SCRATCHPAD_PAGE_ID = "00000000-0000-0000-0002-000000000001";

export const SYSTEM_PAGE_UUIDS = {
  inbox: "00000000-0000-0000-0002-000000000002",
} as const;

export const SYSTEM_PROPERTY_UUIDS = {
  tags: "00000000-0000-0000-0000-000000000001",
  showHierarchy: "00000000-0000-0000-0000-000000000003",
  usedIn: "00000000-0000-0000-0000-000000000004",
  cover: "00000000-0000-0000-0000-000000000005",
  banner: "00000000-0000-0000-0000-000000000006",
  _queryAst: "00000000-0000-0000-0000-000000000007",
  description: "00000000-0000-0000-0000-000000000009",
  _whiteboardData: "00000000-0000-0000-0000-000000000010",
  attachments: "00000000-0000-0000-0000-000000000011",
  authors: "00000000-0000-0000-0000-000000000012",
  isbn: "00000000-0000-0000-0000-000000000013",
  doi: "00000000-0000-0000-0000-000000000014",
  publicationDate: "00000000-0000-0000-0000-000000000015",
  publisher: "00000000-0000-0000-0000-000000000016",
  role: "00000000-0000-0000-0000-000000000017",
  // …0018 withdrawn (v1 locator) — never reuse.
  provenance: "00000000-0000-0000-0000-000000000019",
  highlightAsset: "00000000-0000-0000-0000-000000000020",
  givenName: "00000000-0000-0000-0000-000000000021",
  familyName: "00000000-0000-0000-0000-000000000022",
  citekey: "00000000-0000-0000-0000-000000000023",
  url: "00000000-0000-0000-0000-000000000024",
  // …0025 WITHDRAWN 2026-09-27 (`linkedAuthors`, reversed same day) — never reuse.
  // §34.25 T2 — a class's bound templates (D1: relation lives on the class,
  // multi, targets the template system class).
  hasTemplate: "00000000-0000-0000-0000-000000000026",
  // §34.25 T3 (D1 amendment, owner 2026-10-03) — instantiation provenance: a
  // generated node records its template INSTANCE-SIDE (single node-typed,
  // targets the template class). NOT class-bound — deliberately absent from
  // SYSTEM_PROPERTY_SPECS (whose entries always seed a class binding); the
  // web client self-heals the schema (ensureGeneratedFromProperty).
  generatedFrom: "00000000-0000-0000-0000-000000000027",
  // §34.32 PG10 (owner-via-register-recommendation 2026-10-04) — aliases are
  // BACK (the register contradiction resolves to the v1-parity side): a
  // multi-value text schema, GLOBAL scope with no class binding — aliases
  // are page metadata in v1, and "page" is not a class in the render-state
  // model, so the schema stays unbound and values are authored per node.
  // Search treats alias values as name-equivalents (resolve + unlinked
  // references). New uuid — v1 stored aliases in a table, never a property.
  alias: "00000000-0000-0000-0000-000000000028",
  // Node aliases (issue #7, owner 2026-10-05) — the alias PAGE points at its
  // MAIN page: a single-value node-typed ("object") schema at GLOBAL scope
  // with NO class binding and NO targetClassFilter — both the carrier and
  // the target are "pages", and page is a render state, not a class, so no
  // binding or class filter can express it (the render-state restriction is
  // enforced client-side; SCHEMA.md "Node aliases"). Coexists with the text
  // `alias` schema above (§34.32): text aliases give one page extra NAMES;
  // node aliases link a separate page under a main page and roll their
  // linked references up to it. Values are the existing {nodeId} wire shape.
  aliasOf: "00000000-0000-0000-0000-000000000029",
  taskStatus: "00000000-0000-0000-0003-000000000001",
  taskDeadline: "00000000-0000-0000-0003-000000000002",
  taskScheduled: "00000000-0000-0000-0003-000000000003",
  taskPriority: "00000000-0000-0000-0003-000000000004",
  taskClosedDate: "00000000-0000-0000-0003-000000000005",
  taskRecurrence: "00000000-0000-0000-0003-000000000006",
  // §34.36 meeting family — the workflow-properties block continues (task
  // family …001–…006; meeting family …007–…009). meetingDate is DATE-typed
  // per the whole-day law (SCHEMA.md "Time-of-day on dates"): clock times
  // would need that law amended first, never a silent extension.
  meetingDate: "00000000-0000-0000-0003-000000000007",
  location: "00000000-0000-0000-0003-000000000008",
  agenda: "00000000-0000-0000-0003-000000000009",
  // §34.36 reshape: the EVENT family's minimal date binding — the one that
  // makes `event` (and, via extends, `meeting`) calendar quick-create
  // eligible. Date-only per the whole-day law, like meetingDate.
  eventDate: "00000000-0000-0000-0003-000000000010",
  // §34.36.3: the birthday family's ONLY own property — the person the
  // birthday is for (the date rides eventDate; see the spec comment).
  birthdayPerson: "00000000-0000-0000-0003-000000000011",
} as const;

export type SystemPropertyName = keyof typeof SYSTEM_PROPERTY_UUIDS;

/** Class-scoped system property schemas in canonical seed order (v1 port;
 * v1 `node` type maps to v2 `object`; `classFilter` → `targetClassFilter`).
 * The type union mirrors the wire enum (op-types.ts) — the spec manifest
 * must never outrun it (§34.32 PG14). `bindTo` is optional since PG10
 * (2026-10-04): a spec WITHOUT it seeds the schema alone at global scope
 * (the alias property is deliberately class-unbound — "page" is not a
 * class, and every binding would narrow aliases to one class's members). */
export interface SystemPropertySpec {
  type:
    | "text"
    | "number"
    | "boolean"
    | "date"
    | "date_range"
    | "url"
    | "email"
    | "select"
    | "multi_select"
    | "object"
    | "image";
  multi?: boolean;
  bindTo?: SystemClassName;
  targetClassFilter?: SystemClassName[];
  defaultValue?: string;
  options?: { id: string; label: string }[];
}

export const SYSTEM_PROPERTY_SPECS: Partial<Record<SystemPropertyName, SystemPropertySpec>> = {
  attachments: { type: "object", multi: true, bindTo: "source", targetClassFilter: ["asset"] },
  // Node-typed to agent nodes — bibliography authors ARE agent nodes
  // (SCHEMA.md "Citations — source family and authorship", FINAL owner
  // decision 2026-09-27: `person` and `organization` both extend `agent`).
  authors: { type: "object", multi: true, bindTo: "source", targetClassFilter: ["agent"] },
  isbn: { type: "text", bindTo: "source" },
  doi: { type: "text", bindTo: "source" },
  publicationDate: { type: "date", bindTo: "source" },
  publisher: { type: "text", bindTo: "source" },
  role: {
    type: "select",
    bindTo: "asset",
    options: [
      { id: "00000000-0000-0000-0004-000000000001", label: "representation" },
      { id: "00000000-0000-0000-0004-000000000002", label: "cover" },
      { id: "00000000-0000-0000-0004-000000000003", label: "supplement" },
      { id: "00000000-0000-0000-0004-000000000004", label: "attachment" },
      { id: "00000000-0000-0000-0004-000000000005", label: "generated" },
      { id: "00000000-0000-0000-0004-000000000006", label: "thumbnail" },
      { id: "00000000-0000-0000-0004-000000000007", label: "other" },
    ],
  },
  provenance: { type: "text", bindTo: "highlight" },
  highlightAsset: { type: "object", bindTo: "highlight", targetClassFilter: ["asset"] },
  givenName: { type: "text", bindTo: "person" },
  familyName: { type: "text", bindTo: "person" },
  citekey: { type: "text", bindTo: "source", defaultValue: "" },
  url: { type: "url", bindTo: "weblink" },
  // §34.25 (D1): templates are ordinary nodes of the seeded `template` class;
  // a class binds its templates by authored values on the class node itself.
  hasTemplate: { type: "object", multi: true, bindTo: "class", targetClassFilter: ["template"] },
  // §34.32 PG10 (owner 2026-10-04): aliases return (the v1-parity side of
  // the register contradiction) — multi-value text at GLOBAL scope, no class
  // binding: aliases are page metadata and "page" is not a class. Search
  // indexes the values as name-equivalents (SCHEMA.md "Aliases").
  alias: { type: "text", multi: true },
  // Node aliases (issue #7, owner 2026-10-05): single-value node-typed at
  // GLOBAL scope — the alias page carries {nodeId} of its main page. No
  // bindTo (carrier restriction is render-state: pages only) and no
  // targetClassFilter (targets are pages of any class — page is not a
  // class). The linked-references roll-up and name-equivalence read paths
  // live in the clients (SCHEMA.md "Node aliases").
  aliasOf: { type: "object" },
  // §34.36 (owner 2026-10-04, plain seeds): the meeting family. meetingDate
  // is the family's date binding (quick-create eligibility rides the event
  // root's eventDate too — meeting extends event); location and agenda are
  // plain text per the section's family list.
  meetingDate: { type: "date", bindTo: "meeting" },
  location: { type: "text", bindTo: "meeting" },
  agenda: { type: "text", bindTo: "meeting" },
  // §34.36 reshape: the event family's minimal shape — one date binding.
  eventDate: { type: "date", bindTo: "event" },
  // §34.36.3 (owner directive 2026-10-04): the birthday family is
  // PERSON-typed, not a date duplicate — the date rides event's eventDate
  // through the extends chain (effective-properties binding resolution is
  // extends-aware, store/src/effective.ts). The birthday EVENT links TO the
  // person: object-typed, filter rooted at `person` (extends-aware
  // validation, §34.45/§34.51 — accepts person and any future person
  // subclass; an organization does NOT carry birthdays: its founding day is
  // an ordinary event. Widening the filter to ["agent"] is a one-line seed
  // change if the owner wants org anniversaries).
  birthdayPerson: { type: "object", bindTo: "birthday", targetClassFilter: ["person"] },
};

/**
 * System property schema DISPLAY names (owner directive 2026-10-05, the
 * system-names pass — same law as SYSTEM_CLASS_DISPLAY_NAMES): sentence
 * case for prose names ("Publication date"), uppercase acronyms ("ISBN",
 * "DOI", "URL"), and the task-family entries mirror TASK_FAMILY_SEED's
 * explicit names. The wire keys stay camelCase; these names materialize
 * into property_schema rows at seed/self-heal time and are the labels every
 * properties surface renders. Live rows carrying the raw keys are renamed
 * by scripts/migrate-system-names.mts. One entry per SYSTEM_PROPERTY_UUIDS
 * key — the domain test pins completeness.
 */
export const SYSTEM_PROPERTY_DISPLAY_NAMES: Record<SystemPropertyName, string> = {
  tags: "Tags",
  showHierarchy: "Show hierarchy",
  usedIn: "Used in",
  cover: "Cover",
  banner: "Banner",
  _queryAst: "Query AST",
  description: "Description",
  _whiteboardData: "Whiteboard data",
  attachments: "Attachments",
  authors: "Authors",
  isbn: "ISBN",
  doi: "DOI",
  publicationDate: "Publication date",
  publisher: "Publisher",
  role: "Role",
  provenance: "Provenance",
  highlightAsset: "Highlight asset",
  givenName: "Given name",
  familyName: "Family name",
  citekey: "Citekey",
  url: "URL",
  hasTemplate: "Templates",
  generatedFrom: "Generated from",
  alias: "Aliases",
  aliasOf: "Alias of",
  taskStatus: "Status",
  taskDeadline: "Deadline",
  taskScheduled: "Scheduled",
  taskPriority: "Priority",
  taskClosedDate: "Closed",
  taskRecurrence: "Recurrence",
  meetingDate: "Meeting date",
  location: "Location",
  agenda: "Agenda",
  eventDate: "Event date",
  birthdayPerson: "Birthday person",
};

/** The schema name a seed/self-heal authors for `name` (display wording). */
export function systemPropertyDisplayName(name: SystemPropertyName): string {
  return SYSTEM_PROPERTY_DISPLAY_NAMES[name];
}

/**
 * Extra binding ROWS beyond each spec's single `bindTo` — consumed by the
 * server seed (apps/server/src/seed.ts) and the web self-heal. The one
 * remaining shape: an EXTENDS-CHILD re-binding an inherited schema so
 * class-local binding reads (the calendar quick-create eligibility walk)
 * see it without the child duplicating the schema (birthday→eventDate: the
 * date value itself still resolves through the extends chain at read time).
 * (The cover→source row lived here until 2026-10-05 — owner ruling: a cover
 * makes no sense on sources; the binding is removed from the seeds and from
 * live workspaces by the system-names migration,
 * scripts/migrate-system-names.mts.)
 */
export const SYSTEM_EXTRA_CLASS_BINDINGS: { property: SystemPropertyName; bindTo: SystemClassName; sequence: number }[] = [
  { property: "eventDate", bindTo: "birthday", sequence: 0 },
];

/**
 * The designed task-status glyphs (§34.89) — the v1 icon_visibility-era set
 * re-translated into the §34.43 color grammar (preset tokens, never the
 * retired var(--color-preset-*) encoding): circle-family MDI icons with a
 * distinct color each, so a task's state reads at a glance from the block
 * bullet (Pending = a solid yellow circle, Reviewing = a blue eye-circle,
 * Done = a green check-circle, Cancelled = a red close-circle). Owner-mandated
 * colors: yellow pending, blue review, red cancel, green done.
 */
export const TASK_STATUS_OPTIONS = [
  { name: "Backlog", icon: "mdiCircleOutline", color: "gray" },
  { name: "Pending", icon: "mdiCircle", color: "yellow" },
  { name: "Doing", icon: "mdiCircleHalfFull", color: "orange" },
  { name: "Reviewing", icon: "mdiEyeCircleOutline", color: "blue" },
  { name: "Done", icon: "mdiCheckCircle", color: "green" },
  { name: "Cancelled", icon: "mdiCloseCircle", color: "red" },
] as const;
export const TASK_CLOSED_STATUSES = new Set(["Done", "Cancelled"]);
export const TASK_DEFAULT_STATUS = "Pending";

export const TASK_PRIORITY_OPTIONS = ["Low", "Medium", "High", "Urgent"] as const;

/**
 * §34.35 — deterministic select-option ids for the APPLIER-side task-family
 * seed-ensure (the `workspace.feature.set {feature:"tasks", enabled:true}`
 * path authors the six schemas at apply time, so its option ids must be
 * fixed, not client-random). The select-option namespace (`…0004-…`)
 * continues after the role options (`…0001–…0007`); appended, never reused.
 * Client-side authoring (the web ensureTaskFamily) may pre-date the enable
 * op — the applier ensure is INSERT-or-ignore and never clobbers existing
 * rows (first writer wins, convergent on the single global log).
 */
export const TASK_STATUS_OPTION_UUIDS = {
  backlog: "00000000-0000-0000-0004-000000000008",
  pending: "00000000-0000-0000-0004-000000000009",
  doing: "00000000-0000-0000-0004-00000000000a",
  reviewing: "00000000-0000-0000-0004-00000000000b",
  done: "00000000-0000-0000-0004-00000000000c",
  cancelled: "00000000-0000-0000-0004-00000000000d",
} as const;

export const TASK_PRIORITY_OPTION_UUIDS = {
  low: "00000000-0000-0000-0004-00000000000e",
  medium: "00000000-0000-0000-0004-00000000000f",
  high: "00000000-0000-0000-0004-000000000010",
  urgent: "00000000-0000-0000-0004-000000000011",
} as const;

/**
 * The task-family seed-ensure manifest: six schemas + their task-class
 * bindings, authored idempotently by the store applier when the `tasks`
 * feature enables (§34.35 constraint 5 — closes the "task property schemas
 * never authored in v2" row). Fixed ids end to end (schema + option uuids
 * above); `sequence` is the task-panel display order. `display` (§34.90:
 * property-LEVEL after the owner review) rides the SCHEMA entry — the Status
 * schema defaults to "bullet" (its value rides the block bullet as an icon
 * button, the Logseq-DB "beginning of the block" behavior); the rest stay in
 * the properties panel.
 */
export const TASK_FAMILY_SEED: ReadonlyArray<{
  property: SystemPropertyName;
  name: string;
  type: "select" | "date";
  options?: ReadonlyArray<{ id: string; label: string; icon?: string; color?: string }>;
  display?: "panel" | "bullet" | "inline";
  sequence: number;
}> = [
  {
    property: "taskStatus",
    name: "Status",
    type: "select",
    options: [
      { id: TASK_STATUS_OPTION_UUIDS.backlog, label: "Backlog", icon: "mdiCircleOutline", color: "gray" },
      { id: TASK_STATUS_OPTION_UUIDS.pending, label: "Pending", icon: "mdiCircle", color: "yellow" },
      { id: TASK_STATUS_OPTION_UUIDS.doing, label: "Doing", icon: "mdiCircleHalfFull", color: "orange" },
      { id: TASK_STATUS_OPTION_UUIDS.reviewing, label: "Reviewing", icon: "mdiEyeCircleOutline", color: "blue" },
      { id: TASK_STATUS_OPTION_UUIDS.done, label: "Done", icon: "mdiCheckCircle", color: "green" },
      { id: TASK_STATUS_OPTION_UUIDS.cancelled, label: "Cancelled", icon: "mdiCloseCircle", color: "red" },
    ],
    display: "bullet",
    sequence: 1,
  },
  { property: "taskScheduled", name: "Scheduled", type: "date", sequence: 2 },
  { property: "taskDeadline", name: "Deadline", type: "date", sequence: 3 },
  {
    property: "taskPriority",
    name: "Priority",
    type: "select",
    options: [
      { id: TASK_PRIORITY_OPTION_UUIDS.low, label: "Low" },
      { id: TASK_PRIORITY_OPTION_UUIDS.medium, label: "Medium" },
      { id: TASK_PRIORITY_OPTION_UUIDS.high, label: "High" },
      { id: TASK_PRIORITY_OPTION_UUIDS.urgent, label: "Urgent" },
    ],
    sequence: 4,
  },
  { property: "taskClosedDate", name: "Closed", type: "date", sequence: 5 },
  // v1 migrated recurrence as a plain select (no engine executes it — §34.28
  // #6); authored optionless until the recurrence spec lands.
  { property: "taskRecurrence", name: "Recurrence", type: "select", options: [], sequence: 6 },
];

/**
 * §34.89 convergence helper: restyle a STORED task-status option list with
 * the designed icons/colors, PRESERVING the stored option ids (authored
 * property values reference them — a wholesale options replace must keep
 * ids stable). Matches by label, so self-heals and migration scripts converge
 * workspaces whose family was authored by either seed path (the applier
 * ensure at the fixed UUIDs, the web self-heal at random UUIDs); user-renamed
 * or user-added options pass through untouched. Returns null when nothing
 * needs writing (already converged, or no stored option matches a designed
 * label — nothing safe to change).
 */
export function styleTaskStatusOptions(
  stored: ReadonlyArray<{ id: string; label: string; icon?: string | null; color?: string | null }>,
): Array<{ id: string; label: string; icon?: string | null; color?: string | null }> | null {
  const designed = new Map<string, (typeof TASK_STATUS_OPTIONS)[number]>(
    TASK_STATUS_OPTIONS.map((option) => [option.name, option]),
  );
  let changed = false;
  const restyled = stored.map((option) => {
    const style = designed.get(option.label);
    if (!style) return option;
    if (option.icon === style.icon && option.color === style.color) return option;
    changed = true;
    return { id: option.id, label: option.label, icon: style.icon, color: style.color };
  });
  return changed ? restyled : null;
}

/** Classes the workspace seed emits (nodes + property schemas + bindings + extends). */
export const SEEDED_SYSTEM_CLASSES: SystemClassName[] = [
  "class",
  "day",
  "month",
  "year",
  "quote",
  "query",
  "code",
  "asset",
  "whiteboard",
  "card",
  "task",
  "template",
  "comment",
  "table",
  "note",
  "cloze",
  "source",
  "book",
  "paper",
  "article",
  "thesis",
  "document",
  "agent",
  "person",
  "organization",
  "collection",
  "highlight",
  "weblink",
  "movie",
  "song",
  "tv_series",
  "conference",
  "meeting",
  "event",
  "birthday",
  "definition",
  "idea",
  "place",
  "project",
  "trip",
];
