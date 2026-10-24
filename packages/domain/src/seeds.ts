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
  // …0025 WITHDRAWN 2026-10-23 (source-library roster; Zotero has no "paper"
  // — nodes migrate to journal_article) — never reuse.
  journal_article: "00000000-0000-0000-0001-000000000026",
  thesis: "00000000-0000-0000-0001-000000000027",
  document: "00000000-0000-0000-0001-000000000028",
  agent: "00000000-0000-0000-0001-000000000029",
  person: "00000000-0000-0000-0001-000000000030",
  organization: "00000000-0000-0000-0001-000000000031",
  collection: "00000000-0000-0000-0001-000000000032",
  highlight: "00000000-0000-0000-0001-000000000033",
  web_page: "00000000-0000-0000-0001-000000000034",
  film: "00000000-0000-0000-0001-000000000035",
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
  // Source-library roster (owner 2026-10-23, slice 1 task 3): 30 NEW source
  // type-classes, the Zotero-faithful long tail. Slots …0048–…0065 (hex —
  // the TASK_STATUS_OPTION_UUIDS precedent), assigned ALPHABETICALLY BY KEY
  // for determinism; the domain test pins the exact map. All extend source.
  artwork: "00000000-0000-0000-0001-000000000048",
  audio_recording: "00000000-0000-0000-0001-000000000049",
  bill: "00000000-0000-0000-0001-00000000004a",
  blog_post: "00000000-0000-0000-0001-00000000004b",
  book_section: "00000000-0000-0000-0001-00000000004c",
  computer_program: "00000000-0000-0000-0001-00000000004d",
  conference_paper: "00000000-0000-0000-0001-00000000004e",
  dataset: "00000000-0000-0000-0001-00000000004f",
  dictionary_entry: "00000000-0000-0000-0001-000000000050",
  email: "00000000-0000-0000-0001-000000000051",
  encyclopedia_article: "00000000-0000-0000-0001-000000000052",
  forum_post: "00000000-0000-0000-0001-000000000053",
  hearing: "00000000-0000-0000-0001-000000000054",
  instant_message: "00000000-0000-0000-0001-000000000055",
  interview: "00000000-0000-0000-0001-000000000056",
  letter: "00000000-0000-0000-0001-000000000057",
  magazine_article: "00000000-0000-0000-0001-000000000058",
  manuscript: "00000000-0000-0000-0001-000000000059",
  map: "00000000-0000-0000-0001-00000000005a",
  newspaper_article: "00000000-0000-0000-0001-00000000005b",
  patent: "00000000-0000-0000-0001-00000000005c",
  podcast: "00000000-0000-0000-0001-00000000005d",
  preprint: "00000000-0000-0000-0001-00000000005e",
  presentation: "00000000-0000-0000-0001-00000000005f",
  radio_broadcast: "00000000-0000-0000-0001-000000000060",
  report: "00000000-0000-0000-0001-000000000061",
  standard: "00000000-0000-0000-0001-000000000062",
  statute: "00000000-0000-0000-0001-000000000063",
  tv_broadcast: "00000000-0000-0000-0001-000000000064",
  video_recording: "00000000-0000-0000-0001-000000000065",
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
  journal_article: "mdiNewspaper",
  thesis: "mdiSchoolOutline",
  document: "mdiFileOutline",
  agent: "mdiAccountGroupOutline",
  person: "mdiAccountOutline",
  organization: "mdiDomain",
  collection: "mdiFolderMultipleOutline",
  // mdiFormatColorHighlight: "mdiFormatHighlight" was never a real MDI name —
  // stored rows with it still render via the Icon resolver's legacy alias.
  highlight: "mdiFormatColorHighlight",
  web_page: "mdiLinkVariant",
  film: "mdiMovieOpenOutline",
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
  audio_recording: "mdiMicrophone",
  artwork: "mdiPaletteOutline",
  bill: "mdiScriptTextOutline",
  blog_post: "mdiPostOutline",
  book_section: "mdiTableOfContents",
  computer_program: "mdiCodeBraces",
  conference_paper: "mdiTextBoxOutline",
  dataset: "mdiDatabaseOutline",
  dictionary_entry: "mdiBookAlphabet",
  email: "mdiEmailOutline",
  encyclopedia_article: "mdiLibrary",
  forum_post: "mdiForumOutline",
  hearing: "mdiGavel",
  instant_message: "mdiMessageTextOutline",
  interview: "mdiAccountVoice",
  letter: "mdiMailboxOutline",
  magazine_article: "mdiNewspaperVariant",
  manuscript: "mdiScriptOutline",
  map: "mdiMapOutline",
  newspaper_article: "mdiTextBoxMultipleOutline",
  patent: "mdiStamp",
  podcast: "mdiPodcast",
  preprint: "mdiFileClockOutline",
  presentation: "mdiPresentationPlay",
  radio_broadcast: "mdiRadio",
  report: "mdiFileChartOutline",
  standard: "mdiFileCheckOutline",
  statute: "mdiScaleBalance",
  tv_broadcast: "mdiTelevision",
  video_recording: "mdiVideoOutline",
};

/**
 * System class DISPLAY names (owner directive 2026-10-05: normal wording —
 * "TV series", not "tv_series"). The seed keys stay camelCase/snake_case
 * forever (fixed vocabulary, code-facing); these are the human titles the
 * seeds and self-heals author into class nodes' text content (title-is-
 * content) so every surface (class picker, quick-create, calendar chips,
 * Class View) reads normal wording. Title Case for classes; conventional
 * spellings for acronyms/compounds ("TV series", "Web page"). Live
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
  journal_article: "Journal article",
  thesis: "Thesis",
  document: "Document",
  agent: "Agent",
  person: "Person",
  organization: "Organization",
  collection: "Collection",
  highlight: "Highlight",
  web_page: "Web page",
  film: "Film",
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
  audio_recording: "Audio recording",
  artwork: "Artwork",
  bill: "Bill",
  blog_post: "Blog post",
  book_section: "Book section",
  computer_program: "Computer program",
  conference_paper: "Conference paper",
  dataset: "Dataset",
  dictionary_entry: "Dictionary entry",
  email: "Email",
  encyclopedia_article: "Encyclopedia article",
  forum_post: "Forum post",
  hearing: "Hearing",
  instant_message: "Instant message",
  interview: "Interview",
  letter: "Letter",
  magazine_article: "Magazine article",
  manuscript: "Manuscript",
  map: "Map",
  newspaper_article: "Newspaper article",
  patent: "Patent",
  podcast: "Podcast",
  preprint: "Preprint",
  presentation: "Presentation",
  radio_broadcast: "Radio broadcast",
  report: "Report",
  standard: "Standard",
  statute: "Statute",
  tv_broadcast: "TV broadcast",
  video_recording: "Video recording",
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
  journal_article: "A journal or magazine article.",
  thesis: "A thesis or dissertation.",
  document: "Any other document — the family fallback.",
  agent: "An author or organization that creates sources.",
  person: "A person — the people graph and contact fields.",
  organization: "A company, institution, or group.",
  collection: "A manual grouping of nodes.",
  highlight: "A highlighted passage from a source.",
  web_page: "A bookmarked web page, cited as a source.",
  film: "A film, with director and cast fields.",
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
  audio_recording: "A recorded audio program — speech, music, or sound.",
  artwork: "A visual artwork — painting, sculpture, or photograph.",
  bill: "A bill — a proposed law before a legislature.",
  blog_post: "A post published on a blog or personal site.",
  book_section: "A chapter or section of a book.",
  computer_program: "A software program or application.",
  conference_paper: "A paper published in conference proceedings.",
  dataset: "A dataset — research data or statistics.",
  dictionary_entry: "An entry from a dictionary or glossary.",
  email: "An email message, cited as a source.",
  encyclopedia_article: "An entry from an encyclopedia.",
  forum_post: "A post on an online forum or discussion board.",
  hearing: "A legislative or legal hearing.",
  instant_message: "An instant message or chat message.",
  interview: "An interview — conducted or published.",
  letter: "A personal or business letter.",
  magazine_article: "An article from a magazine.",
  manuscript: "An unpublished or pre-publication manuscript.",
  map: "A map or other cartographic work.",
  newspaper_article: "An article from a newspaper.",
  patent: "A granted patent.",
  podcast: "A podcast episode or series.",
  preprint: "A preprint — research before peer review.",
  presentation: "A talk, lecture, or set of slides.",
  radio_broadcast: "A radio program or broadcast.",
  report: "A technical, governmental, or institutional report.",
  standard: "A technical standard or specification.",
  statute: "A statute — enacted law.",
  tv_broadcast: "A TV program or broadcast.",
  video_recording: "A recorded video — clip, excerpt, or program.",
};

/** The card description the gallery renders for `name`. */
export function systemClassDescription(name: SystemClassName): string {
  return SYSTEM_CLASS_DESCRIPTIONS[name];
}

/** Canonical `extends` edges between system classes (multiple inheritance-ready). */
export const SYSTEM_CLASS_EXTENDS: Partial<Record<SystemClassName, SystemClassName[]>> = {
  book: ["source"],
  journal_article: ["source"],
  thesis: ["source"],
  document: ["source"],
  film: ["source"],
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
  // The web page IS a source (owner ruling): a bookmarked page is a cited
  // web source — the web_page class inherits the source family's
  // bibliographic bindings, while its own `url` binding stays the
  // class-local winner (effective binding resolution is own-first,
  // packages/store/src/effective.ts). Disabling `source` hides web pages
  // with the rest of the family.
  web_page: ["source"],
  // Source-library roster (owner 2026-10-23, slice 1 task 3): the 30-new
  // source type-classes ALL extend source — the Zotero-faithful long tail
  // inherits the family's bibliographic bindings; the sources toggle
  // archives/revives them with the family.
  audio_recording: ["source"],
  artwork: ["source"],
  bill: ["source"],
  blog_post: ["source"],
  book_section: ["source"],
  computer_program: ["source"],
  conference_paper: ["source"],
  dataset: ["source"],
  dictionary_entry: ["source"],
  email: ["source"],
  encyclopedia_article: ["source"],
  forum_post: ["source"],
  hearing: ["source"],
  instant_message: ["source"],
  interview: ["source"],
  letter: ["source"],
  magazine_article: ["source"],
  manuscript: ["source"],
  map: ["source"],
  newspaper_article: ["source"],
  patent: ["source"],
  podcast: ["source"],
  preprint: ["source"],
  presentation: ["source"],
  radio_broadcast: ["source"],
  report: ["source"],
  standard: ["source"],
  statute: ["source"],
  tv_broadcast: ["source"],
  video_recording: ["source"],
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
  // SYSTEM_PROPERTY_SPECS (whose bound entries normally seed a class binding
  // — `bind: false` excepted, owner ruling 2026-10-24); the web client
  // self-heals the schema (ensureGeneratedFromProperty).
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
  // Bibliographic property pool (owner 2026-10-23, source-library slice 1
  // task 4): ONE reusable schema per Zotero field, every entry seeded at the
  // family base (`bindTo: "source"` — the schema's scope; RULING 2026-10-24:
  // only the shared base seeds a BINDING row on source, every type-specific
  // field is `bind: false` and binds on its own class via
  // SYSTEM_SOURCE_CLASS_BINDINGS). Slots …0001/…0002 are pinned by the
  // controller (linkedAuthors reinstatement, editors); the rest continue the
  // block ALPHABETICALLY BY KEY for determinism (the …0048 roster precedent)
  // — the domain test pins the exact map. Deliberately absent: the case-type
  // orphans (caseName/court/docketNumber/reporter/reporterVolume/firstPage/
  // dateDecided — `case` has no class, owner ruling) and the already-seeded
  // fields (isbn …0013/doi …0014/publicationDate …0015/publisher …0016/
  // url …0024/citekey …0023 — never duplicated). Zotero's `type` field is
  // keyed `workType` (`type` cannot be a TS object key).
  // REINSTATED 2026-10-23 after the 2026-09-27 withdrawal (the node-typed
  // authorship experiment returns as its own property; the withdrawn …0025
  // UUID stays burned, never reused).
  linkedAuthors: "00000000-0000-0000-0006-000000000001",
  editors: "00000000-0000-0000-0006-000000000002",
  abstract: "00000000-0000-0000-0006-000000000003",
  accessDate: "00000000-0000-0000-0006-000000000004",
  applicationNumber: "00000000-0000-0000-0006-000000000005",
  archive: "00000000-0000-0000-0006-000000000006",
  archiveLocation: "00000000-0000-0000-0006-000000000007",
  artworkMedium: "00000000-0000-0000-0006-000000000008",
  artworkSize: "00000000-0000-0000-0006-000000000009",
  assignee: "00000000-0000-0000-0006-00000000000a",
  blogTitle: "00000000-0000-0000-0006-00000000000b",
  bookTitle: "00000000-0000-0000-0006-00000000000c",
  callNumber: "00000000-0000-0000-0006-00000000000d",
  code: "00000000-0000-0000-0006-00000000000e",
  codeNumber: "00000000-0000-0000-0006-00000000000f",
  codePages: "00000000-0000-0000-0006-000000000010",
  codeVolume: "00000000-0000-0000-0006-000000000011",
  committee: "00000000-0000-0000-0006-000000000012",
  company: "00000000-0000-0000-0006-000000000013",
  dateEnacted: "00000000-0000-0000-0006-000000000014",
  distributor: "00000000-0000-0000-0006-000000000015",
  documentNumber: "00000000-0000-0000-0006-000000000016",
  edition: "00000000-0000-0000-0006-000000000017",
  episodeNumber: "00000000-0000-0000-0006-000000000018",
  eventPlace: "00000000-0000-0000-0006-000000000019",
  extra: "00000000-0000-0000-0006-00000000001a",
  filingDate: "00000000-0000-0000-0006-00000000001b",
  format: "00000000-0000-0000-0006-00000000001c",
  forumTitle: "00000000-0000-0000-0006-00000000001d",
  genre: "00000000-0000-0000-0006-00000000001e",
  history: "00000000-0000-0000-0006-00000000001f",
  identifier: "00000000-0000-0000-0006-000000000020",
  institution: "00000000-0000-0000-0006-000000000021",
  interviewMedium: "00000000-0000-0000-0006-000000000022",
  issn: "00000000-0000-0000-0006-000000000023",
  issue: "00000000-0000-0000-0006-000000000024",
  issueDate: "00000000-0000-0000-0006-000000000025",
  issuingAuthority: "00000000-0000-0000-0006-000000000026",
  label: "00000000-0000-0000-0006-000000000027",
  language: "00000000-0000-0000-0006-000000000028",
  legalStatus: "00000000-0000-0000-0006-000000000029",
  legislativeBody: "00000000-0000-0000-0006-00000000002a",
  letterType: "00000000-0000-0000-0006-00000000002b",
  medium: "00000000-0000-0000-0006-00000000002c",
  meetingName: "00000000-0000-0000-0006-00000000002d",
  nameOfAct: "00000000-0000-0000-0006-00000000002e",
  network: "00000000-0000-0000-0006-00000000002f",
  numPages: "00000000-0000-0000-0006-000000000030",
  number: "00000000-0000-0000-0006-000000000031",
  numberOfVolumes: "00000000-0000-0000-0006-000000000032",
  pages: "00000000-0000-0000-0006-000000000033",
  patentNumber: "00000000-0000-0000-0006-000000000034",
  place: "00000000-0000-0000-0006-000000000035",
  postType: "00000000-0000-0000-0006-000000000036",
  priorityDate: "00000000-0000-0000-0006-000000000037",
  priorityNumbers: "00000000-0000-0000-0006-000000000038",
  proceedingsTitle: "00000000-0000-0000-0006-000000000039",
  programTitle: "00000000-0000-0000-0006-00000000003a",
  programmingLanguage: "00000000-0000-0000-0006-00000000003b",
  publicLawNumber: "00000000-0000-0000-0006-00000000003c",
  publicationTitle: "00000000-0000-0000-0006-00000000003d",
  references: "00000000-0000-0000-0006-00000000003e",
  reportNumber: "00000000-0000-0000-0006-00000000003f",
  reportType: "00000000-0000-0000-0006-000000000040",
  repository: "00000000-0000-0000-0006-000000000041",
  repositoryLocation: "00000000-0000-0000-0006-000000000042",
  rights: "00000000-0000-0000-0006-000000000043",
  runningTime: "00000000-0000-0000-0006-000000000044",
  scale: "00000000-0000-0000-0006-000000000045",
  section: "00000000-0000-0000-0006-000000000046",
  series: "00000000-0000-0000-0006-000000000047",
  seriesNumber: "00000000-0000-0000-0006-000000000048",
  seriesTitle: "00000000-0000-0000-0006-000000000049",
  session: "00000000-0000-0000-0006-00000000004a",
  shortTitle: "00000000-0000-0000-0006-00000000004b",
  status: "00000000-0000-0000-0006-00000000004c",
  studio: "00000000-0000-0000-0006-00000000004d",
  system: "00000000-0000-0000-0006-00000000004e",
  thesisType: "00000000-0000-0000-0006-00000000004f",
  university: "00000000-0000-0000-0006-000000000050",
  versionNumber: "00000000-0000-0000-0006-000000000051",
  volume: "00000000-0000-0000-0006-000000000052",
  websiteTitle: "00000000-0000-0000-0006-000000000053",
  websiteType: "00000000-0000-0000-0006-000000000054",
  workType: "00000000-0000-0000-0006-000000000055",
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
   * Owner ruling 2026-10-24: binding-row emission on `bindTo`. Default true —
   * a bound spec seeds the schema scoped to `bindTo` AND a class_property row
   * on it. `bind: false` keeps the schema seeding with its `bindTo` scope
   * (scope is the locality/eligibility authority) but SKIPS the binding row
   * (bindings are visibility): the property is eligible on the class family
   * yet renders bound only where a class-local row exists — the source
   * bibliographic pool's non-base fields ride their per-class
   * SYSTEM_SOURCE_CLASS_BINDINGS rows, not the source base.
   */
  bind?: boolean;
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
  // RETYPED 2026-10-23 (owner ruling, source-library slice 1 task 4):
  // object→text, multi — authors are free-text strings on the source
  // family; the node-typed experiment is reinstated as `linkedAuthors`
  // (…0006-…0001). Live values migrate via scripts/migrate-authors-to-text.mts
  // (slice 1 task 8); the UUID …0012 is unchanged and the object filter is
  // superseded (a text schema takes no targetClassFilter).
  authors: { type: "text", multi: true, bindTo: "source" },
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
  // source of any kind carries a link), not web_page-only — bindTo moves to
  // `source` with web_page re-bound class-locally via
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
  // Bibliographic property pool (owner 2026-10-23, source-library slice 1
  // task 4): ONE reusable schema per Zotero field, every entry scoped to the
  // family base (`bindTo: "source"` — the scope makes every family member
  // ELIGIBLE through the extends chain). RULING 2026-10-24 (owner): only the
  // SHARED BASE seeds a binding row on source — linkedAuthors/editors here
  // (authors/isbn/doi/publicationDate/publisher/citekey/url/attachments ride
  // the …0000- block above) — every type-specific field carries `bind: false`:
  // NO class_property row on source, so a source node renders ONLY the base
  // plus its own class's SYSTEM_SOURCE_CLASS_BINDINGS rows (bindings are
  // visibility, scope is eligibility). All plain single-value text unless
  // noted otherwise; accessDate is datetime (day precision is the schema
  // default). The case-type orphans have no pool slot (see the UUID block
  // comment) and already-seeded fields (isbn/doi/publicationDate/publisher/
  // url/citekey) are not duplicated.
  // linkedAuthors — REINSTATED 2026-10-23 after the 2026-09-27 withdrawal:
  // the node-typed authorship experiment returns as its own property, now
  // coexisting with the free-text `authors` (retyped the same day). The
  // withdrawn …0025 UUID stays burned, never reused.
  linkedAuthors: { type: "object", multi: true, bindTo: "source", targetClassFilter: ["agent"] },
  editors: { type: "text", multi: true, bindTo: "source" },
  abstract: { type: "text", bindTo: "source", bind: false },
  accessDate: { type: "datetime", bindTo: "source", bind: false },
  applicationNumber: { type: "text", bindTo: "source", bind: false },
  archive: { type: "text", bindTo: "source", bind: false },
  archiveLocation: { type: "text", bindTo: "source", bind: false },
  artworkMedium: { type: "text", bindTo: "source", bind: false },
  artworkSize: { type: "text", bindTo: "source", bind: false },
  assignee: { type: "text", bindTo: "source", bind: false },
  blogTitle: { type: "text", bindTo: "source", bind: false },
  bookTitle: { type: "text", bindTo: "source", bind: false },
  callNumber: { type: "text", bindTo: "source", bind: false },
  code: { type: "text", bindTo: "source", bind: false },
  codeNumber: { type: "text", bindTo: "source", bind: false },
  codePages: { type: "text", bindTo: "source", bind: false },
  codeVolume: { type: "text", bindTo: "source", bind: false },
  committee: { type: "text", bindTo: "source", bind: false },
  company: { type: "text", bindTo: "source", bind: false },
  dateEnacted: { type: "text", bindTo: "source", bind: false },
  distributor: { type: "text", bindTo: "source", bind: false },
  documentNumber: { type: "text", bindTo: "source", bind: false },
  edition: { type: "text", bindTo: "source", bind: false },
  episodeNumber: { type: "text", bindTo: "source", bind: false },
  eventPlace: { type: "text", bindTo: "source", bind: false },
  extra: { type: "text", bindTo: "source", bind: false },
  filingDate: { type: "text", bindTo: "source", bind: false },
  format: { type: "text", bindTo: "source", bind: false },
  forumTitle: { type: "text", bindTo: "source", bind: false },
  genre: { type: "text", bindTo: "source", bind: false },
  history: { type: "text", bindTo: "source", bind: false },
  identifier: { type: "text", bindTo: "source", bind: false },
  institution: { type: "text", bindTo: "source", bind: false },
  interviewMedium: { type: "text", bindTo: "source", bind: false },
  issn: { type: "text", bindTo: "source", bind: false },
  issue: { type: "text", bindTo: "source", bind: false },
  issueDate: { type: "text", bindTo: "source", bind: false },
  issuingAuthority: { type: "text", bindTo: "source", bind: false },
  label: { type: "text", bindTo: "source", bind: false },
  language: { type: "text", bindTo: "source", bind: false },
  legalStatus: { type: "text", bindTo: "source", bind: false },
  legislativeBody: { type: "text", bindTo: "source", bind: false },
  letterType: { type: "text", bindTo: "source", bind: false },
  medium: { type: "text", bindTo: "source", bind: false },
  meetingName: { type: "text", bindTo: "source", bind: false },
  nameOfAct: { type: "text", bindTo: "source", bind: false },
  network: { type: "text", bindTo: "source", bind: false },
  numPages: { type: "text", bindTo: "source", bind: false },
  number: { type: "text", bindTo: "source", bind: false },
  numberOfVolumes: { type: "text", bindTo: "source", bind: false },
  pages: { type: "text", bindTo: "source", bind: false },
  patentNumber: { type: "text", bindTo: "source", bind: false },
  place: { type: "text", bindTo: "source", bind: false },
  postType: { type: "text", bindTo: "source", bind: false },
  priorityDate: { type: "text", bindTo: "source", bind: false },
  priorityNumbers: { type: "text", bindTo: "source", bind: false },
  proceedingsTitle: { type: "text", bindTo: "source", bind: false },
  programTitle: { type: "text", bindTo: "source", bind: false },
  programmingLanguage: { type: "text", bindTo: "source", bind: false },
  publicLawNumber: { type: "text", bindTo: "source", bind: false },
  publicationTitle: { type: "text", bindTo: "source", bind: false },
  references: { type: "text", bindTo: "source", bind: false },
  reportNumber: { type: "text", bindTo: "source", bind: false },
  reportType: { type: "text", bindTo: "source", bind: false },
  repository: { type: "text", bindTo: "source", bind: false },
  repositoryLocation: { type: "text", bindTo: "source", bind: false },
  rights: { type: "text", bindTo: "source", bind: false },
  runningTime: { type: "text", bindTo: "source", bind: false },
  scale: { type: "text", bindTo: "source", bind: false },
  section: { type: "text", bindTo: "source", bind: false },
  series: { type: "text", bindTo: "source", bind: false },
  seriesNumber: { type: "text", bindTo: "source", bind: false },
  seriesTitle: { type: "text", bindTo: "source", bind: false },
  session: { type: "text", bindTo: "source", bind: false },
  shortTitle: { type: "text", bindTo: "source", bind: false },
  // "Standard status" — not "Status": the task family's taskStatus already
  // owns the "Status" display name and the uniqueness law (owner directive
  // 2026-10-05) forbids two seeds collapsing into one label.
  status: { type: "text", bindTo: "source", bind: false },
  studio: { type: "text", bindTo: "source", bind: false },
  system: { type: "text", bindTo: "source", bind: false },
  thesisType: { type: "text", bindTo: "source", bind: false },
  university: { type: "text", bindTo: "source", bind: false },
  versionNumber: { type: "text", bindTo: "source", bind: false },
  volume: { type: "text", bindTo: "source", bind: false },
  websiteTitle: { type: "text", bindTo: "source", bind: false },
  websiteType: { type: "text", bindTo: "source", bind: false },
  workType: { type: "text", bindTo: "source", bind: false },
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
  // Bibliographic property pool (source-library slice 1 task 4) — sentence
  // case, conventional acronyms (ISSN); the full pin lives in the pool test.
  linkedAuthors: "Linked authors",
  editors: "Editors",
  abstract: "Abstract",
  accessDate: "Accessed",
  applicationNumber: "Application number",
  archive: "Archive",
  archiveLocation: "Archive location",
  artworkMedium: "Artwork medium",
  artworkSize: "Artwork size",
  assignee: "Assignee",
  blogTitle: "Blog title",
  bookTitle: "Book title",
  callNumber: "Call number",
  code: "Code",
  codeNumber: "Code number",
  codePages: "Code pages",
  codeVolume: "Code volume",
  committee: "Committee",
  company: "Company",
  dateEnacted: "Date enacted",
  distributor: "Distributor",
  documentNumber: "Document number",
  edition: "Edition",
  episodeNumber: "Episode number",
  eventPlace: "Event place",
  extra: "Extra",
  filingDate: "Filing date",
  format: "Format",
  forumTitle: "Forum title",
  genre: "Genre",
  history: "History",
  identifier: "Identifier",
  institution: "Institution",
  interviewMedium: "Interview medium",
  issn: "ISSN",
  issue: "Issue",
  issueDate: "Issue date",
  issuingAuthority: "Issuing authority",
  label: "Label",
  language: "Language",
  legalStatus: "Legal status",
  legislativeBody: "Legislative body",
  letterType: "Letter type",
  medium: "Medium",
  meetingName: "Meeting name",
  nameOfAct: "Name of act",
  network: "Network",
  numPages: "Number of pages",
  number: "Number",
  numberOfVolumes: "Number of volumes",
  pages: "Pages",
  patentNumber: "Patent number",
  place: "Place",
  postType: "Post type",
  priorityDate: "Priority date",
  priorityNumbers: "Priority numbers",
  proceedingsTitle: "Proceedings title",
  programTitle: "Program title",
  programmingLanguage: "Programming language",
  publicLawNumber: "Public law number",
  publicationTitle: "Publication title",
  references: "References",
  reportNumber: "Report number",
  reportType: "Report type",
  repository: "Repository",
  repositoryLocation: "Repository location",
  rights: "Rights",
  runningTime: "Running time",
  scale: "Scale",
  section: "Section",
  series: "Series",
  seriesNumber: "Series number",
  seriesTitle: "Series title",
  session: "Session",
  shortTitle: "Short title",
  status: "Standard status",
  studio: "Studio",
  system: "System",
  thesisType: "Thesis type",
  university: "University",
  versionNumber: "Version",
  volume: "Volume",
  websiteTitle: "Website title",
  websiteType: "Website type",
  workType: "Type",
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
 * family base (web_page→url, owner 2026-10-22: url binds to `source` now;
 * web_page's own row survives so own-first resolution keeps naming web_page —
 * see SCHEMA.md "Citations").
 * (The cover→source row lived here until 2026-10-05 — owner ruling: a cover
 * makes no sense on sources; the binding is removed from the seeds and from
 * live workspaces by the system-names migration,
 * scripts/migrate-system-names.mts.)
 */
export const SYSTEM_EXTRA_CLASS_BINDINGS: { property: SystemPropertyName; bindTo: SystemClassName }[] = [
  { property: "eventDate", bindTo: "birthday" },
  { property: "url", bindTo: "web_page" },
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

/**
 * The class-level parentlessRole "block" seed (owner 2026-10-24): classes
 * whose PARENTLESS members render in the Block role — standalone captures
 * (tasks, quotes, highlights, assets, comments, cloze) and small structural
 * elements (queries, templates, tables, code, cards, definitions, ideas,
 * events) surface through queries/collections/search-blocks instead of the
 * Pages chrome. The server seed and the web ensure paths emit the flag on
 * class.create; live workspaces converge by the one-time Path A migration
 * (scripts/migrate-class-parentless-role.mts). `meeting` and `birthday` are
 * deliberately ABSENT — they inherit the demote through `event` via
 * SYSTEM_CLASS_EXTENDS (the effective flag derives at read time; one-way
 * demote, no per-level unflag).
 */
export const SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK: ReadonlySet<SystemClassName> = new Set([
  "quote",
  "code",
  "asset",
  "card",
  "task",
  "template",
  "comment",
  "table",
  "cloze",
  "highlight",
  "query",
  "definition",
  "idea",
  "event",
]);

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
  "journal_article",
  "thesis",
  "document",
  "agent",
  "person",
  "organization",
  "collection",
  "highlight",
  "web_page",
  "film",
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
  // Source-library roster (owner 2026-10-23, slice 1 task 3): the 30-new
  // source type-classes seed with the family (extends source).
  "audio_recording",
  "artwork",
  "bill",
  "blog_post",
  "book_section",
  "computer_program",
  "conference_paper",
  "dataset",
  "dictionary_entry",
  "email",
  "encyclopedia_article",
  "forum_post",
  "hearing",
  "instant_message",
  "interview",
  "letter",
  "magazine_article",
  "manuscript",
  "map",
  "newspaper_article",
  "patent",
  "podcast",
  "preprint",
  "presentation",
  "radio_broadcast",
  "report",
  "standard",
  "statute",
  "tv_broadcast",
  "video_recording",
];

/**
 * Source-library roster (owner 2026-10-23, slice 1 task 3): the new source
 * type-classes that seed ARCHIVED (`active = false`) — the long tail nobody
 * wants in a fresh workspace's gallery and pickers. EIGHTEEN names (the
 * task brief's prose says 17; its own list carries 18 — the list is the
 * authority, and the domain test pins it verbatim): the everyday types
 * (book_section, magazine_article, newspaper_article, preprint, report,
 * standard, podcast, the broadcasts, the conference trio, audio/video) stay
 * ENABLED by default. Nothing consumes this yet — it is seed data for the
 * later slices (the ensure paths seed the archived bit from it).
 */
export const SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES: readonly SystemClassName[] = [
  "artwork",
  "bill",
  "blog_post",
  "computer_program",
  "dataset",
  "dictionary_entry",
  "email",
  "encyclopedia_article",
  "forum_post",
  "hearing",
  "instant_message",
  "interview",
  "letter",
  "manuscript",
  "map",
  "patent",
  "radio_broadcast",
  "statute",
];
