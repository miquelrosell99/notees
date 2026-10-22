/**
 * System seeds — fixed UUIDs ported from
 * `app/domain/entities/constants.py` (guarded there by
 * `tests/core/test_system_uuid_parity.py`).
 *
 * HARD RULE (Revision 6 precedent): these ids are baked into fixtures,
 * exports, and future migration scripts. Never rename, never regenerate.
 * New system entities append; withdrawn ids are never reused
 * (precedent: `locator` …0018 withdrawn).
 */

export const SYSTEM_CLASS_UUIDS = {
  // …0001 WITHDRAWN 2026-10-07 (owner ruling): the seeded `class` META class
  // is retired — nodes bound to it become REAL classes (class.create on an
  // existing node, the conversion capability) and the seed no longer emits
  // it. The `has-template` family relocated to a global-scope schema (no
  // class-class host). Never reuse.
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
  // Meeting system (owner ruling 2026-10-04: plain seeds — zero wire
  // cost, seed convergence only).
  meeting: "00000000-0000-0000-0001-000000000039",
  // RESHAPE (owner directive 2026-10-04): `event` is the CALENDAR
  // family root — the date-only base class the calendar story builds on;
  // `meeting` extends it (SYSTEM_CLASS_EXTENDS below), so disabling event
  // disables meetings with it, not vice versa.
  event: "00000000-0000-0000-0001-000000000040",
  // (owner directive 2026-10-04): `birthday` extends `event` — a
  // person's birthday is an event on the calendar (eventDate drives the chip
  // via the birthday binding row seeded in SYSTEM_EXTRA_CLASS_BINDINGS); the
  // family itself is person-typed (birthdayPerson), not a date duplicate.
  birthday: "00000000-0000-0000-0001-000000000041",
  // …0042 WITHDRAWN 2026-10-04 (same day it was minted): the `cover` system
  // class duplicated the cover PROPERTY's meaning (owner directive — a cover
  // is an ordinary ASSET-classed node; the property value stays the only
  // authority, the card-view badge derives from it). Never reuse.
  // #14 follow-up: the deploy catalog's missing everyday classes
  // (owner list: definition, idea, place, project, trip) — plain seeds per
  // the ruling above (zero wire cost, seed convergence only). trip extends
  // event (a trip is calendar-bound; the events toggle cascades to it).
  definition: "00000000-0000-0000-0001-000000000043",
  idea: "00000000-0000-0000-0001-000000000044",
  place: "00000000-0000-0000-0001-000000000045",
  project: "00000000-0000-0000-0001-000000000046",
  trip: "00000000-0000-0000-0001-000000000047",
} as const;

export type SystemClassName = keyof typeof SYSTEM_CLASS_UUIDS;

export const SYSTEM_CLASS_ICONS: Record<SystemClassName, string> = {
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
  // mdiFormatColorHighlight: "mdiFormatHighlight" was never a real MDI name —
  // stored rows with it still render via the Icon resolver's legacy alias.
  highlight: "mdiFormatColorHighlight",
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

/**
 * One-line gallery descriptions (owner ruling 2026-10-22, the
 * classes-gallery batch) — the card grid under every gallery-toggleable
 * system class (the classes gallery, the picker enable rows). Display
 * metadata only, following the icons/display-names manifest pattern:
 * additive, no wire change, converging by seed id not by text.
 */
export const SYSTEM_CLASS_DESCRIPTIONS: Record<SystemClassName, string> = {
  year: "The journal year chain — always on.",
  month: "The journal month chain — always on.",
  day: "The journal day chain — always on.",
  quote: "Pull quotes and excerpts, cited in place.",
  query: "A live, saved search over the object graph.",
  code: "A code page with syntax-highlighted blocks.",
  asset: "An uploaded file, content-addressed.",
  whiteboard: "A freeform spatial canvas of cards and shapes.",
  card: "A compact summary card for an entity.",
  task: "Checkable work items with status and priority.",
  template: "A reusable page skeleton for instantiation.",
  comment: "A discussion thread anchored to a node.",
  table: "A structured data table view.",
  warning: "A warning callout in the page body.",
  note: "A neutral callout in the page body.",
  tip: "A tip callout in the page body.",
  info: "An info callout in the page body.",
  danger: "A danger callout in the page body.",
  success: "A success callout in the page body.",
  cloze: "A text with hidden gaps for recall.",
  source: "A cited source with bibliographic fields.",
  book: "A book, with authors and edition fields.",
  paper: "An academic paper, with DOI and venue.",
  article: "A journal or magazine article.",
  thesis: "A thesis or dissertation.",
  document: "Any other document — the family fallback.",
  agent: "An author or organization that creates sources.",
  person: "A person — the people graph and contact fields.",
  organization: "A company, institution, or group.",
  collection: "A manual grouping of nodes.",
  highlight: "A highlighted passage from a source.",
  weblink: "A bookmarked web page, cited as a source.",
  movie: "A film, with director and cast fields.",
  song: "A song or track, with artist and album.",
  tv_series: "A TV series, with season and episode fields.",
  conference: "A conference or talk.",
  meeting: "A meeting, with date, location, and agenda.",
  event: "A calendar event, dated through the day chain.",
  birthday: "A person's birthday on the calendar.",
  definition: "A term and its definition.",
  idea: "A captured idea, developed later or never.",
  place: "A place — visited, planned, or referenced.",
  project: "A project with a goal and state.",
  trip: "A journey on the calendar.",
};

/** The card description the gallery renders for `name`. */
export function systemClassDescription(name: SystemClassName): string {
  return SYSTEM_CLASS_DESCRIPTIONS[name];
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
  // Reshape (owner directive 2026-10-04): meeting IS-A event — the
  // calendar family root. meeting's own family (meetingDate/location/agenda)
  // stays meeting-specific on top of the event date.
  meeting: ["event"],
  // A birthday IS an event (a person's birthday lands on the
  // calendar through the event chain, exactly like a meeting).
  birthday: ["event"],
  // #14 follow-up: a trip IS an event — calendar-bound, so the
  // events-family toggle cascades to it (SYSTEM_CLASS_EXTENDS is the
  // cascade authority).
  trip: ["event"],
  // The web link IS a source (owner ruling): a bookmarked page is a cited
  // web source — the weblink class inherits the source family's
  // bibliographic bindings, while its own `url` binding stays the
  // class-local winner (effective binding resolution is own-first,
  // packages/store/src/effective.ts). Disabling `source` hides weblinks
  // with the rest of the family.
  weblink: ["source"],
};

/**
 * The event-family reshape — the future Features tab's gating semantics, encoded as a
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

/**
 * The frozen extends parent set per system class UUID (name-keyed
 * SYSTEM_CLASS_EXTENDS resolved to ids) — the system-extends lock authority
 * (SCHEMA.md "Class properties"): a system class's extends mapping is seeded
 * platform structure the feature-toggle cascade (`systemClassAncestors`) and
 * binding inheritance (the store's `class_extends` walk) both derive from, so
 * `class.setExtends` on a system class only applies when the payload's parent
 * set EQUALS the seeded set (the seed/ensure re-issue convergence path);
 * every deviation fails loud at the applier. Classes absent from
 * SYSTEM_CLASS_EXTENDS are frozen to the empty set. User classes stay freely
 * extensible, including onto system bases.
 */
export const SYSTEM_CLASS_EXTENDS_IDS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    (Object.entries(SYSTEM_CLASS_UUIDS) as Array<[SystemClassName, string]>).map(
      ([name, id]) => [
        id,
        (SYSTEM_CLASS_EXTENDS[name] ?? []).map((parent) => SYSTEM_CLASS_UUIDS[parent]),
      ],
    ),
  );

/** True when the id is a fixed system-class seed UUID. */
export function isSystemClassId(id: string): boolean {
  return Object.hasOwn(SYSTEM_CLASS_EXTENDS_IDS, id);
}

// Owner ruling 2026-10-05: the scratchpad page is WITHDRAWN — "not wanted
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
  // …0018 withdrawn (`locator`) — never reuse.
  provenance: "00000000-0000-0000-0000-000000000019",
  highlightAsset: "00000000-0000-0000-0000-000000000020",
  givenName: "00000000-0000-0000-0000-000000000021",
  familyName: "00000000-0000-0000-0000-000000000022",
  citekey: "00000000-0000-0000-0000-000000000023",
  url: "00000000-0000-0000-0000-000000000024",
  // …0025 WITHDRAWN 2026-09-27 (`linkedAuthors`, reversed same day) — never reuse.
  // T2 — a class's bound templates (D1: relation lives on the class,
  // multi, targets the template system class). GLOBAL scope since
  // 2026-10-07 (the class-class retirement): the retired `class` meta class
  // used to host the binding; values are authored on class nodes directly
  // (the aliasOf precedent — no class can host a universal binding).
  hasTemplate: "00000000-0000-0000-0000-000000000026",
  // T3 (D1 amendment, owner 2026-10-03) — instantiation provenance: a
  // generated node records its template INSTANCE-SIDE (single node-typed,
  // targets the template class). NOT class-bound — deliberately absent from
  // SYSTEM_PROPERTY_SPECS (whose entries always seed a class binding); the
  // web client self-heals the schema (ensureGeneratedFromProperty).
  generatedFrom: "00000000-0000-0000-0000-000000000027",
  // PG10 (owner recommendation 2026-10-04) — aliases are
  // BACK (the contradiction resolves to the parity side): a
  // multi-value text schema, GLOBAL scope with no class binding — aliases
  // are page metadata, and "page" is not a class in the render-state
  // model, so the schema stays unbound and values are authored per node.
  // Search treats alias values as name-equivalents (resolve + unlinked
  // references). New uuid — aliases used to live in a table, never a property.
  alias: "00000000-0000-0000-0000-000000000028",
  // Node aliases (issue #7, owner 2026-10-05) — the alias PAGE points at its
  // MAIN page: a single-value node-typed ("object") schema at GLOBAL scope
  // with NO class binding and NO targetClassFilter — both the carrier and
  // the target are "pages", and page is a render state, not a class, so no
  // binding or class filter can express it (the render-state restriction is
  // enforced client-side; SCHEMA.md "Node aliases"). Coexists with the text
  // `alias` schema above: text aliases give one page extra NAMES;
  // node aliases link a separate page under a main page and roll their
  // linked references up to it. Values are the existing {nodeId} wire shape.
  aliasOf: "00000000-0000-0000-0000-000000000029",
  taskStatus: "00000000-0000-0000-0003-000000000001",
  taskDeadline: "00000000-0000-0000-0003-000000000002",
  taskScheduled: "00000000-0000-0000-0003-000000000003",
  taskPriority: "00000000-0000-0000-0003-000000000004",
  taskClosedDate: "00000000-0000-0000-0003-000000000005",
  taskRecurrence: "00000000-0000-0000-0003-000000000006",
  // Meeting family — the workflow-properties block continues (task
  // family …001–…006; meeting family …007–…009). meetingDate is DATETIME-typed
  // per the amended time-of-day law (SCHEMA.md "Time-of-day on dates",
  // AMENDED 2026-10-09): values may carry a wall-clock `time` beside the
  // day-node anchor — full-day stays the default.
  meetingDate: "00000000-0000-0000-0003-000000000007",
  location: "00000000-0000-0000-0003-000000000008",
  agenda: "00000000-0000-0000-0003-000000000009",
  // Event-family reshape: the EVENT family's minimal date binding — the one that
  // makes `event` (and, via extends, `meeting`) calendar quick-create
  // eligible. Datetime-typed per the amended law, like meetingDate.
  eventDate: "00000000-0000-0000-0003-000000000010",
  // The birthday family's ONLY own property — the person the
  // birthday is for (the date rides eventDate; see the spec comment).
  birthdayPerson: "00000000-0000-0000-0003-000000000011",
} as const;

export type SystemPropertyName = keyof typeof SYSTEM_PROPERTY_UUIDS;

/**
 * The READONLY derivation list (owner ruling 2026-10-21): the retired
 * `readonly` render contract was never user configuration — an enumeration
 * of the seeds (seeds.ts + the GTK/Flutter seed manifests) finds ZERO
 * system properties that ever carried the flag — so the contract retires
 * from the wire/store entirely and readonly-ness DERIVES from the system
 * list instead (store nothing that is a fact about system seeds — the
 * binding-`sequence` philosophy).
 *
 * The list is the platform-PROVENANCE properties: values authored by
 * platform flows, not user data. `generatedFrom` is written by template
 * instantiation (T3/D1); `alias` is name-equivalence metadata surfaced
 * through the dedicated aliases UI. Clients dim/disable these properties'
 * editors exactly where the old flag did (never blocking a write — PC1).
 * Everything else (bibliographic fields, the task/meeting families, names)
 * is ordinary user data and stays editable. Correcting the list is a
 * one-line change here (fixed seed UUIDs, precise).
 */
export const READONLY_SYSTEM_PROPERTY_IDS: readonly string[] = [
  SYSTEM_PROPERTY_UUIDS.generatedFrom,
  SYSTEM_PROPERTY_UUIDS.alias,
];

/** True when the schema id is a system property whose editors render
 *  readonly (dimmed/disabled — the retired render contract, now derived). */
export function isReadonlyProperty(schemaId: string): boolean {
  return READONLY_SYSTEM_PROPERTY_IDS.includes(schemaId);
}

/** Class-scoped system property schemas in canonical seed order (ported;
 * the old `node` type maps to `object`; `classFilter` → `targetClassFilter`).
 * The type union mirrors the wire enum (op-types.ts) — the spec manifest
 * must never outrun it (PG14). `bindTo` is optional since PG10
 * (2026-10-04): a spec WITHOUT it seeds the schema alone at global scope
 * (the alias property is deliberately class-unbound — "page" is not a
 * class, and every binding would narrow aliases to one class's members). */
export interface SystemPropertySpec {
  type:
    | "text"
    | "number"
    | "boolean"
    | "datetime"
    | "url"
    | "email"
    | "select"
    | "multi_select"
    | "object"
    | "image"
    | "asset";
  multi?: boolean;
  bindTo?: SystemClassName;
  /**
   * Owner ruling 2026-10-20 (the seed-scope audit): a bound spec normally
   * seeds its schema LOCAL to `bindTo` (scopeClassIds [bindClass]) — the
   * binding row still lands on `bindTo` (bindings are per-class config),
   * but `global: true` flips the SCHEMA's scope to global for genuinely
   * reusable properties. citekey is the counter-precedent: explicitly
   * ruled local to `source` + extensions.
   */
  global?: boolean;
  targetClassFilter?: SystemClassName[];
  defaultValue?: string;
  options?: { id: string; label: string }[];
}

export const SYSTEM_PROPERTY_SPECS: Partial<Record<SystemPropertyName, SystemPropertySpec>> = {
  // M38 (owner 2026-10-07): the `asset` property TYPE — a node-typed value
  // ({ nodeId }) whose target must carry the ASSET class, the filter implicit
  // in the type (an explicit targetClassFilter is redundant — dropped here;
  // live rows retype via scripts/migrate-attachments-asset-type.mts, values
  // already point at asset nodes and need no rewrite). attachments leads the
  // type out of `object`.
  attachments: { type: "asset", multi: true, bindTo: "source" },
  // Node-typed to agent nodes — bibliography authors ARE agent nodes
  // (SCHEMA.md "Citations — source family and authorship", FINAL owner
  // decision 2026-09-27: `person` and `organization` both extend `agent`).
  authors: { type: "object", multi: true, bindTo: "source", targetClassFilter: ["agent"] },
  isbn: { type: "text", bindTo: "source" },
  doi: { type: "text", bindTo: "source" },
  publicationDate: { type: "datetime", bindTo: "source" },
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
  // Owner 2026-10-22: url is a DEFAULT PROPERTY of the source family (a
  // source of any kind carries a link), not weblink-only — bindTo moves to
  // `source` with weblink re-bound class-locally via
  // SYSTEM_EXTRA_CLASS_BINDINGS (the birthday→eventDate shape). The SCHEMA
  // stays GLOBAL per the 2026-10-20 seed-scope audit — a url is generically
  // reusable (the binding row lands on source either way; bindings are
  // per-class config, zero availability semantics).
  url: { type: "url", bindTo: "source", global: true },
  // D1: templates are ordinary nodes of the seeded `template` class;
  // a class binds its templates by authored values on the class node itself.
  // M47 (2026-10-07): the relation hosts on NO class — global scope, no
  // binding (the class-class retirement; the aliasOf precedent). The
  // template target filter stays (write-time validation).
  hasTemplate: { type: "object", multi: true, targetClassFilter: ["template"] },
  // PG10 (owner 2026-10-04): aliases return (the parity side of
  // the contradiction) — multi-value text at GLOBAL scope, no class
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
  // Owner ruling 2026-10-04 (plain seeds): the meeting family. meetingDate
  // is the family's date binding (quick-create eligibility rides the event
  // root's eventDate too — meeting extends event); location and agenda are
  // plain text per the section's family list.
  meetingDate: { type: "datetime", bindTo: "meeting" },
  location: { type: "text", bindTo: "meeting" },
  agenda: { type: "text", bindTo: "meeting" },
  // Event-family reshape: the event family's minimal shape — one date binding.
  eventDate: { type: "datetime", bindTo: "event" },
  // (owner directive 2026-10-04): the birthday family is
  // PERSON-typed, not a date duplicate — the date rides event's eventDate
  // through the extends chain (effective-properties binding resolution is
  // extends-aware, store/src/effective.ts). The birthday EVENT links TO the
  // person: object-typed, filter rooted at `person` (extends-aware
  // validation — accepts person and any future person
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
 * server seed (apps/server/src/seed.ts) and the web self-heal. Two shapes:
 * (1) an EXTENDS-CHILD re-binding an inherited schema so class-local binding
 * reads (the calendar quick-create eligibility walk) see it without the
 * child duplicating the schema (birthday→eventDate: the date value itself
 * still resolves through the extends chain at read time); (2) a family-child
 * keeping its class-local row when the schema's primary binding moves to the
 * family base (weblink→url, owner 2026-10-22: url binds to `source` now;
 * weblink's own row survives so own-first resolution keeps naming weblink —
 * see SCHEMA.md "Citations").
 * (The cover→source row lived here until 2026-10-05 — owner ruling: a cover
 * makes no sense on sources; the binding is removed from the seeds and from
 * live workspaces by the system-names migration,
 * scripts/migrate-system-names.mts.)
 */
export const SYSTEM_EXTRA_CLASS_BINDINGS: { property: SystemPropertyName; bindTo: SystemClassName }[] = [
  { property: "eventDate", bindTo: "birthday" },
  { property: "url", bindTo: "weblink" },
];

/**
 * The designed task-status glyphs — the icon_visibility-era set
 * re-translated into the color grammar (preset tokens, never the
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
 * Deterministic select-option ids for the APPLIER-side task-family
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
 * feature enables (constraint 5 — closes the "task property schemas
 * never authored" row). Fixed ids end to end (schema + option uuids
 * above). `display` (property-LEVEL after the owner review) rides the
 * SCHEMA entry — the Status schema defaults to "bullet" (its value rides
 * the block bullet as an icon button, the Logseq-DB "beginning of the
 * block" behavior); the rest stay in the properties panel. Binding rows
 * carry NO order: class panels render alphabetically by property name
 * (owner ruling 2026-10-21 — `sequence` retired from the binding).
 *
 * Owner ruling 2026-10-20 (the seed-scope audit): the SIX SCHEMAS seed at
 * GLOBAL scope (scopeClassIds absent — Status "can be reused for other
 * nodes", and the ruling covers the whole family); the task-class BINDING
 * ROWS below are untouched (bindings are per-class config, zero availability
 * semantics).
 */
export const TASK_FAMILY_SEED: ReadonlyArray<{
  property: SystemPropertyName;
  name: string;
  type: "select" | "datetime";
  options?: ReadonlyArray<{ id: string; label: string; icon?: string; color?: string }>;
  display?: "panel" | "bullet" | "inline";
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
  },
  { property: "taskScheduled", name: "Scheduled", type: "datetime" },
  { property: "taskDeadline", name: "Deadline", type: "datetime" },
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
  },
  { property: "taskClosedDate", name: "Closed", type: "datetime" },
  // Migrated workspaces carry recurrence as a plain select (no engine
  // executes it); authored optionless until the recurrence spec lands.
  { property: "taskRecurrence", name: "Recurrence", type: "select", options: [] },
];

/**
 * Convergence helper: restyle a STORED task-status option list with
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
