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
};

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
};

export const SYSTEM_PAGE_UUIDS = {
  scratchpad: "00000000-0000-0000-0002-000000000001",
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
  linkedAuthors: "00000000-0000-0000-0000-000000000025",
  taskStatus: "00000000-0000-0000-0003-000000000001",
  taskDeadline: "00000000-0000-0000-0003-000000000002",
  taskScheduled: "00000000-0000-0000-0003-000000000003",
  taskPriority: "00000000-0000-0000-0003-000000000004",
  taskClosedDate: "00000000-0000-0000-0003-000000000005",
  taskRecurrence: "00000000-0000-0000-0003-000000000006",
} as const;

export type SystemPropertyName = keyof typeof SYSTEM_PROPERTY_UUIDS;

/** Class-scoped system property schemas in canonical seed order (v1 port;
 * v1 `node` type maps to v2 `object`; `classFilter` → `targetClassFilter`). */
export interface SystemPropertySpec {
  type: "text" | "number" | "boolean" | "date" | "url" | "email" | "select" | "object";
  multi?: boolean;
  bindTo: SystemClassName;
  targetClassFilter?: SystemClassName[];
  defaultValue?: string;
  options?: { id: string; label: string }[];
}

export const SYSTEM_PROPERTY_SPECS: Partial<Record<SystemPropertyName, SystemPropertySpec>> = {
  attachments: { type: "object", multi: true, bindTo: "source", targetClassFilter: ["asset"] },
  // Plain text list, verbatim strings — never person nodes (SCHEMA.md
  // "Citations", owner decision 2026-09-27: import writes the strings as-is).
  authors: { type: "text", multi: true, bindTo: "source" },
  // Explicit person linkage for the authors who matter to the graph.
  linkedAuthors: { type: "object", multi: true, bindTo: "source", targetClassFilter: ["agent"] },
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
};

/** Extra bindings for schemas created outside SYSTEM_PROPERTY_SPECS (global cover). */
export const SYSTEM_EXTRA_CLASS_BINDINGS: { property: SystemPropertyName; bindTo: SystemClassName; sequence: number }[] = [
  { property: "cover", bindTo: "source", sequence: 7 },
];

export const TASK_STATUS_OPTIONS = [
  { name: "Backlog" },
  { name: "Pending" },
  { name: "Doing" },
  { name: "Reviewing" },
  { name: "Done" },
  { name: "Cancelled" },
] as const;
export const TASK_CLOSED_STATUSES = new Set(["Done", "Cancelled"]);
export const TASK_DEFAULT_STATUS = "Pending";

export const TASK_PRIORITY_OPTIONS = ["Low", "Medium", "High", "Urgent"] as const;

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
];
