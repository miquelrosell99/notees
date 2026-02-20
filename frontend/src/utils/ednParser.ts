/**
 * EDN (Extensible Data Notation) Parser for Logseq DB graph exports.
 *
 * Parses the Logseq EDN export format into structured JS objects
 * that can be imported as Notees nodes.
 */

// ── EDN Tokenizer ──────────────────────────────────────────────

type Token =
  | { type: 'open_map' }        // {
  | { type: 'close_map' }       // }
  | { type: 'open_vec' }        // [
  | { type: 'close_vec' }       // ]
  | { type: 'open_set' }        // #{
  | { type: 'keyword'; value: string }   // :foo/bar
  | { type: 'string'; value: string }    // "hello"
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }  // true / false
  | { type: 'nil' }
  | { type: 'symbol'; value: string }    // unquoted identifiers
  | { type: 'tagged'; tag: string }      // #uuid, #inst etc.
  | { type: 'discard' };                 // #_

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const peek = () => input[i];
  const advance = () => input[i++];
  const isWhitespace = (c: string) => /[\s,]/.test(c); // commas are whitespace in EDN

  while (i < input.length) {
    const c = peek();

    // Skip whitespace & commas
    if (isWhitespace(c)) { advance(); continue; }

    // Skip line comments
    if (c === ';') {
      while (i < input.length && input[i] !== '\n') advance();
      continue;
    }

    // Map / Set / Vec delimiters
    if (c === '{') { advance(); tokens.push({ type: 'open_map' }); continue; }
    if (c === '}') { advance(); tokens.push({ type: 'close_map' }); continue; }
    if (c === '[') { advance(); tokens.push({ type: 'open_vec' }); continue; }
    if (c === ']') { advance(); tokens.push({ type: 'close_vec' }); continue; }

    // # prefix: set #{, tagged literal #uuid, discard #_
    if (c === '#') {
      advance();
      const next = peek();
      if (next === '{') { advance(); tokens.push({ type: 'open_set' }); continue; }
      if (next === '_') { advance(); tokens.push({ type: 'discard' }); continue; }
      // Tagged literal — read the tag name
      let tag = '';
      while (i < input.length && !isWhitespace(peek()) && !/[{}\[\]()]/.test(peek())) {
        tag += advance();
      }
      tokens.push({ type: 'tagged', tag });
      continue;
    }

    // String
    if (c === '"') {
      advance(); // opening quote
      let str = '';
      while (i < input.length && peek() !== '"') {
        if (peek() === '\\') { advance(); str += advance(); }
        else { str += advance(); }
      }
      advance(); // closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Keyword  :foo  :foo/bar
    if (c === ':') {
      let kw = '';
      advance(); // skip :
      while (i < input.length && !isWhitespace(peek()) && !/[{}\[\]()#"]/.test(peek())) {
        kw += advance();
      }
      tokens.push({ type: 'keyword', value: kw });
      continue;
    }

    // Number or symbol  (very loose — we refine in the parser)
    let atom = '';
    while (i < input.length && !isWhitespace(peek()) && !/[{}\[\]()#";]/.test(peek())) {
      atom += advance();
    }

    if (atom === 'true')  { tokens.push({ type: 'boolean', value: true }); continue; }
    if (atom === 'false') { tokens.push({ type: 'boolean', value: false }); continue; }
    if (atom === 'nil')   { tokens.push({ type: 'nil' }); continue; }

    const num = Number(atom);
    if (!isNaN(num) && atom !== '') {
      tokens.push({ type: 'number', value: num });
    } else {
      tokens.push({ type: 'symbol', value: atom });
    }
  }

  return tokens;
}

// ── EDN Parser ─────────────────────────────────────────────────

type EdnValue =
  | string
  | number
  | boolean
  | null
  | EdnKeyword
  | EdnTagged
  | EdnValue[]
  | Set<EdnValue>
  | Map<EdnValue, EdnValue>;

/** Wrapper so keywords don't collide with plain strings. */
class EdnKeyword {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() { return `:${this.value}`; }
}

/** Tagged literal (e.g. #uuid "..."). */
class EdnTagged {
  readonly tag: string;
  readonly value: EdnValue;
  constructor(tag: string, value: EdnValue) {
    this.tag = tag;
    this.value = value;
  }
}

function parse(tokens: Token[]): EdnValue {
  let pos = 0;

  function next(): Token {
    if (pos >= tokens.length) throw new Error('Unexpected end of input');
    return tokens[pos++];
  }

  function readValue(): EdnValue {
    const tok = next();

    switch (tok.type) {
      case 'string':  return tok.value;
      case 'number':  return tok.value;
      case 'boolean': return tok.value;
      case 'nil':     return null;
      case 'keyword': return new EdnKeyword(tok.value);
      case 'symbol':  return tok.value; // treat as string

      case 'open_vec': {
        const arr: EdnValue[] = [];
        while (tokens[pos]?.type !== 'close_vec') {
          arr.push(readValue());
        }
        pos++; // skip ]
        return arr;
      }

      case 'open_map': {
        const map = new Map<EdnValue, EdnValue>();
        while (tokens[pos]?.type !== 'close_map') {
          const key = readValue();
          const val = readValue();
          map.set(key, val);
        }
        pos++; // skip }
        return map;
      }

      case 'open_set': {
        const set = new Set<EdnValue>();
        while (tokens[pos]?.type !== 'close_map') { // sets close with }
          set.add(readValue());
        }
        pos++; // skip }
        return set;
      }

      case 'tagged': {
        const inner = readValue();
        return new EdnTagged(tok.tag, inner);
      }

      case 'discard': {
        readValue(); // read and throw away the next form
        return readValue(); // then return the one after
      }

      default:
        throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
    }
  }

  return readValue();
}

/** Parse an EDN string into an EdnValue tree. */
export function parseEdn(input: string): EdnValue {
  const tokens = tokenize(input);
  return parse(tokens);
}

// ── Helpers to navigate the parsed tree ────────────────────────

/** Get a value from an EDN map by keyword name. */
function mapGet(map: EdnValue, key: string): EdnValue | undefined {
  if (!(map instanceof Map)) return undefined;
  for (const [k, v] of map.entries()) {
    if (k instanceof EdnKeyword && k.value === key) return v;
  }
  return undefined;
}

// ── Logseq EDN → Intermediate representation ──────────────────

export interface LogseqSelectionOption {
  value: unknown;
  uuid?: string;
}

export interface LogseqProperty {
  id: string;           // e.g. "user.property/Autor-UEGDrhRa"
  title: string;        // Human-readable: "Autor"
  type: string;         // :node, :date, :checkbox, :default, :number
  cardinality: string;  // :db.cardinality/one | :db.cardinality/many
  classFilters?: string[]; // For node-type: class ids that restrict selection
  selectionOptions?: LogseqSelectionOption[]; // For closed-values / selection
}

export interface LogseqClass {
  id: string;           // e.g. "user.class/libro-SHcT7TN6"
  title: string;
  uuid?: string;
  extends?: string;     // Parent class id
  properties?: string[]; // Property ids assigned to this class
}

export interface LogseqBlock {
  title: string;
  uuid?: string;
  tags?: string[];      // class ids (same as pages)
  properties?: Record<string, unknown>;
  children?: LogseqBlock[];
}

export interface LogseqPage {
  title: string;
  uuid?: string;
  journal?: string;     // YYYY-MM-DD date string for journal/daily pages
  tags?: string[];      // class ids
  aliases?: string[];   // alias page titles (from logseq.property/alias)
  aliasOfUuids?: string[]; // UUIDs from :block/alias (this page is an alias of those targets)
  parent?: string;      // Parent page title (from logseq.property/parent namespace hierarchy)
  properties?: Record<string, unknown>;
  blocks: LogseqBlock[];
}

export interface LogseqExport {
  pages: LogseqPage[];
  properties: LogseqProperty[];
  classes: LogseqClass[];
  /** 'block' when the EDN is a single-block export (no parent page) */
  exportType?: 'block' | 'page';
  /** Standalone blocks from a :block export (not attached to any page) */
  standaloneBlocks?: LogseqBlock[];
}

/**
 * Transform raw EDN (parsed) into the LogseqExport intermediate form.
 */
export function ednToLogseqExport(edn: EdnValue): LogseqExport {
  if (!(edn instanceof Map)) throw new Error('Top-level EDN must be a map');

  // ── Properties ───────────────────────────────────
  const propsMap = mapGet(edn, 'properties');
  const properties: LogseqProperty[] = [];
  if (propsMap instanceof Map) {
    for (const [k, v] of propsMap.entries()) {
      if (!(k instanceof EdnKeyword)) continue;
      // Skip logseq system properties — only import user properties
      if (k.value.startsWith('logseq.property')) continue;
      const title = asString(mapGet(v, 'block/title')) ?? k.value;
      let typeKw = mapGet(v, 'logseq.property/type');
      // Fallback: some EDN exports use block/schema {:type :node} instead
      if (!typeKw) {
        const schema = mapGet(v, 'block/schema');
        if (schema instanceof Map) {
          typeKw = mapGet(schema, 'type');
        }
      }
      const cardKw = mapGet(v, 'db/cardinality');

      // Class filters for node-type properties
      const classFiltersVec = mapGet(v, 'build/property-classes');
      let classFilters: string[] | undefined;
      if (Array.isArray(classFiltersVec)) {
        classFilters = classFiltersVec
          .filter((c): c is EdnKeyword => c instanceof EdnKeyword)
          .map(c => c.value);
      }

      // Closed values (selection options)
      const closedVals = mapGet(v, 'build/closed-values');
      let selectionOptions: LogseqSelectionOption[] | undefined;
      if (Array.isArray(closedVals)) {
        selectionOptions = [];
        for (const cv of closedVals) {
          if (!(cv instanceof Map)) continue;
          const val = mapGet(cv, 'value');
          const uuidTagged = mapGet(cv, 'uuid');
          selectionOptions.push({
            value: val,
            uuid: uuidTagged instanceof EdnTagged ? String(uuidTagged.value) : undefined,
          });
        }
      }

      properties.push({
        id: k.value,
        title,
        type: typeKw instanceof EdnKeyword ? typeKw.value : 'default',
        cardinality: cardKw instanceof EdnKeyword ? cardKw.value : 'db.cardinality/one',
        classFilters: classFilters && classFilters.length > 0 ? classFilters : undefined,
        selectionOptions: selectionOptions && selectionOptions.length > 0 ? selectionOptions : undefined,
      });
    }
  }

  // ── Classes ──────────────────────────────────────
  const classesMap = mapGet(edn, 'classes');
  const classes: LogseqClass[] = [];
  if (classesMap instanceof Map) {
    for (const [k, v] of classesMap.entries()) {
      if (!(k instanceof EdnKeyword)) continue;
      const title = asString(mapGet(v, 'block/title')) ?? k.value;
      const uuidTagged = mapGet(v, 'block/uuid');
      const uuid = uuidTagged instanceof EdnTagged ? String(uuidTagged.value) : undefined;
      const extendsVec = mapGet(v, 'build/class-extends');
      let extendsId: string | undefined;
      if (Array.isArray(extendsVec) && extendsVec.length > 0 && extendsVec[0] instanceof EdnKeyword) {
        extendsId = extendsVec[0].value;
      }
      const classProps = mapGet(v, 'build/class-properties');
      let propIds: string[] | undefined;
      if (Array.isArray(classProps)) {
        propIds = classProps
          .filter((p): p is EdnKeyword => p instanceof EdnKeyword)
          .map(p => p.value);
      }
      classes.push({ id: k.value, title, uuid, extends: extendsId, properties: propIds });
    }
  }

  // Build UUID→class title map so pages without a title can inherit
  // the class title when their UUID matches a class UUID.
  const classUuidToTitle = new Map<string, string>();
  for (const cls of classes) {
    if (cls.uuid && cls.title) {
      classUuidToTitle.set(cls.uuid, cls.title);
    }
  }

  // ── Pages & Blocks ───────────────────────────────
  const pagesVec = mapGet(edn, 'pages-and-blocks');
  const pages: LogseqPage[] = [];
  if (Array.isArray(pagesVec)) {
    for (const entry of pagesVec) {
      if (!(entry instanceof Map)) continue;
      const pageMap = mapGet(entry, 'page');
      if (!pageMap || !(pageMap instanceof Map)) continue;

      // Detect journal/daily pages
      // 1. Explicit build/journal field (number like 20231118 or string)
      const journalRaw = mapGet(pageMap, 'build/journal');
      let journalDate: string | undefined;
      if (typeof journalRaw === 'number') {
        const s = String(journalRaw);
        if (s.length === 8) journalDate = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
      } else if (typeof journalRaw === 'string') {
        // Handle build/journal as string (e.g. "20231118" or "2023-11-18")
        const stripped = journalRaw.replace(/-/g, '');
        if (/^\d{8}$/.test(stripped)) {
          journalDate = `${stripped.slice(0,4)}-${stripped.slice(4,6)}-${stripped.slice(6,8)}`;
        }
      }

      const uuidTagged = mapGet(pageMap, 'block/uuid');
      const uuid = uuidTagged instanceof EdnTagged ? String(uuidTagged.value) : undefined;

      const rawTitle = asString(mapGet(pageMap, 'block/title'));
      // Fallback: if the page has no title but its UUID matches a class,
      // use the class title (class pages often have title only in :classes)
      const title = rawTitle ?? classUuidToTitle.get(uuid ?? '') ?? (journalDate ?? '');

      // 2. If no build/journal, detect date pages from title format
      if (!journalDate && rawTitle) {
        journalDate = detectDateFromTitle(rawTitle);
      }

      // Tags (classes assigned to this page)
      const tagsVec = mapGet(pageMap, 'build/tags');
      const tags: string[] = [];
      if (Array.isArray(tagsVec)) {
        for (const t of tagsVec) {
          if (t instanceof EdnKeyword) tags.push(t.value);
        }
      }

      // Properties on this page
      const propsOnPage = mapGet(pageMap, 'build/properties');
      const pageProperties: Record<string, unknown> = {};
      const pageAliases: string[] = [];
      let pageParent: string | undefined;
      if (propsOnPage instanceof Map) {
        for (const [pk, pv] of propsOnPage.entries()) {
          if (!(pk instanceof EdnKeyword)) continue;
          // Extract parent page before skipping other system properties
          if (pk.value === 'logseq.property/parent') {
            const resolved = resolvePropertyValue(pv);
            if (resolved && typeof resolved === 'object' && (resolved as Record<string, unknown>).__type === 'page-ref') {
              pageParent = (resolved as Record<string, string>).title;
            }
            continue;
          }
          // Extract aliases before skipping other system properties
          if (pk.value === 'logseq.property/alias') {
            const resolved = resolvePropertyValue(pv);
            const items = Array.isArray(resolved) ? resolved : [resolved];
            for (const item of items) {
              if (item && typeof item === 'object' && (item as Record<string, unknown>).__type === 'page-ref') {
                pageAliases.push((item as Record<string, string>).title);
              } else if (typeof item === 'string') {
                pageAliases.push(item);
              }
            }
            continue;
          }
          // Skip other logseq system properties (but allow description through)
          if (pk.value.startsWith('logseq.property') && pk.value !== 'logseq.property/description') continue;
          pageProperties[pk.value] = resolvePropertyValue(pv);
        }
      }

      // :block/alias — set of [:block/uuid #uuid "..."] references
      // When present, this page is an alias OF the referenced target pages
      const aliasSet = mapGet(pageMap, 'block/alias');
      const aliasOfUuids: string[] = [];
      if (aliasSet instanceof Set) {
        for (const ref of aliasSet) {
          // Each entry is [:block/uuid #uuid "..."] — a 2-element vector
          if (Array.isArray(ref) && ref.length === 2
              && ref[0] instanceof EdnKeyword && ref[0].value === 'block/uuid'
              && ref[1] instanceof EdnTagged) {
            aliasOfUuids.push(String(ref[1].value));
          }
        }
      }

      // Blocks
      const blocksVec = mapGet(entry, 'blocks');
      const blocks: LogseqBlock[] = [];
      if (Array.isArray(blocksVec)) {
        for (const b of blocksVec) {
          blocks.push(parseBlock(b));
        }
      }

      pages.push({
        title,
        uuid,
        journal: journalDate,
        tags: tags.length > 0 ? tags : undefined,
        aliases: pageAliases.length > 0 ? pageAliases : undefined,
        aliasOfUuids: aliasOfUuids.length > 0 ? aliasOfUuids : undefined,
        parent: pageParent,
        properties: Object.keys(pageProperties).length > 0 ? pageProperties : undefined,
        blocks,
      });
    }
  }

  // ── Handle :block export type ──────────────────────────────
  // When export-type is :block, the actual block data (title, tags, properties)
  // is in the top-level :logseq.db.sqlite.export/block key, NOT in pages-and-blocks.
  // We store it as a standalone block — the import modal will attach it to the
  // currently active node or today's page.
  const exportType = mapGet(edn, 'logseq.db.sqlite.export/export-type');
  let detectedExportType: 'block' | 'page' | undefined;
  const standaloneBlocks: LogseqBlock[] = [];
  if (exportType instanceof EdnKeyword && exportType.value === 'block') {
    detectedExportType = 'block';
    const blockData = mapGet(edn, 'logseq.db.sqlite.export/block');
    if (blockData instanceof Map) {
      standaloneBlocks.push(parseBlock(blockData));
    }
  }

  // ── Fallback: raw block map format ─────────────────────────
  // Logseq sometimes exports a bare block map (e.g. copied from the DB
  // inspector) that looks like:
  //   {:block/uuid #uuid "..." :block/title "..." :block/name "..." ...}
  // It has no :pages-and-blocks key. We treat it as a single page to import.
  if (pages.length === 0 && !detectedExportType) {
    const rawUuidTagged = mapGet(edn, 'block/uuid');
    const rawTitle = asString(mapGet(edn, 'block/title')) ?? asString(mapGet(edn, 'block/name'));
    if (rawUuidTagged instanceof EdnTagged && rawTitle) {
      const rawUuid = String(rawUuidTagged.value);
      detectedExportType = 'page';
      pages.push({
        title: rawTitle,
        uuid: rawUuid,
        blocks: [],
      });
    }
  }

  return {
    pages,
    properties,
    classes,
    ...(detectedExportType ? { exportType: detectedExportType } : {}),
    ...(standaloneBlocks.length > 0 ? { standaloneBlocks } : {}),
  };
}

// ── Internal helpers ───────────────────────────────────────────

function asString(v: EdnValue | undefined): string | null {
  if (typeof v === 'string') return v;
  return null;
}

/**
 * Detect a date from a page title string.
 * Supports common Logseq journal title formats:
 *   - YYYY-MM-DD, YYYY/MM/DD (ISO-style)
 *   - DD-MM-YYYY, DD/MM/YYYY (European-style)
 *   - MM-DD-YYYY, MM/DD/YYYY (US-style)
 *   - "Nov 18th, 2023", "November 18th, 2023" (English ordinal)
 *   - "Nov 18, 2023", "November 18, 2023" (English plain)
 *
 * Returns YYYY-MM-DD string if detected, else undefined.
 */
function detectDateFromTitle(title: string): string | undefined {
  const t = title.trim();

  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    if (isValidDate(+y, +m, +d)) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY (day > 12 → unambiguous European)
  // MM-DD-YYYY or MM/DD/YYYY (when first part ≤ 12, assume DD/MM if second ≤ 12 too — prefer European)
  const dmy = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const [, a, b, y] = dmy;
    // Try DD/MM/YYYY first (European), then MM/DD/YYYY
    if (isValidDate(+y, +b, +a)) return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (isValidDate(+y, +a, +b)) return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }

  // English month names: "Nov 18th, 2023" or "November 18, 2023"
  const enMatch = t.match(
    /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i
  );
  if (enMatch) {
    const [, mon, d, y] = enMatch;
    const m = monthNameToNumber(mon);
    if (m && isValidDate(+y, m, +d)) return `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // "18 Nov 2023" or "18 November 2023" (reversed English)
  const enRevMatch = t.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s+(\d{4})$/i
  );
  if (enRevMatch) {
    const [, d, mon, y] = enRevMatch;
    const m = monthNameToNumber(mon);
    if (m && isValidDate(+y, m, +d)) return `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  return undefined;
}

function isValidDate(year: number, month: number, day: number): boolean {
  return year >= 1900 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function monthNameToNumber(name: string): number | undefined {
  return MONTH_NAMES[name.toLowerCase()];
}

/** Convert a build/journal EDN value (number or string) to YYYY-MM-DD, or undefined. */
function journalFieldToDate(v: EdnValue | undefined): string | undefined {
  if (typeof v === 'number') {
    const s = String(v);
    if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  }
  if (typeof v === 'string') {
    const stripped = v.replace(/-/g, '');
    if (/^\d{8}$/.test(stripped)) {
      return `${stripped.slice(0,4)}-${stripped.slice(4,6)}-${stripped.slice(6,8)}`;
    }
  }
  return undefined;
}
function parseBlock(raw: EdnValue): LogseqBlock {
  if (!(raw instanceof Map)) return { title: String(raw) };
  const title = asString(mapGet(raw, 'block/title')) ?? '';
  const uuidTagged = mapGet(raw, 'block/uuid');
  const uuid = uuidTagged instanceof EdnTagged ? String(uuidTagged.value) : undefined;

  // Tags (classes assigned to this block)
  const tagsVec = mapGet(raw, 'build/tags');
  const tags: string[] = [];
  if (Array.isArray(tagsVec)) {
    for (const t of tagsVec) {
      if (t instanceof EdnKeyword) tags.push(t.value);
    }
  }

  // Properties on this block
  const propsOnBlock = mapGet(raw, 'build/properties');
  const blockProperties: Record<string, unknown> = {};
  if (propsOnBlock instanceof Map) {
    for (const [pk, pv] of propsOnBlock.entries()) {
      if (!(pk instanceof EdnKeyword)) continue;
      if (pk.value.startsWith('logseq.property') && pk.value !== 'logseq.property/description') continue;
      blockProperties[pk.value] = resolvePropertyValue(pv);
    }
  }

  const childrenVec = mapGet(raw, 'build/children');
  let children: LogseqBlock[] | undefined;
  if (Array.isArray(childrenVec)) {
    children = childrenVec.map(parseBlock);
  }
  return {
    title,
    uuid,
    tags: tags.length > 0 ? tags : undefined,
    properties: Object.keys(blockProperties).length > 0 ? blockProperties : undefined,
    children,
  };
}

/**
 * Resolve a property value from the EDN tree.
 * Returns structured values:
 * - booleans for checkboxes
 * - strings for text
 * - numbers for numeric values
 * - { __type: 'page-ref', title: string } for node references
 * - { __type: 'date-ref', date: 'YYYY-MM-DD' } for date references
 * - { __type: 'uuid-ref', uuid: string } for UUID references (selection closed values)
 * - arrays of the above for multi-value
 */
function resolvePropertyValue(v: EdnValue): unknown {
  if (v instanceof Set) {
    return [...v].map(resolvePropertyValue);
  }
  if (v instanceof EdnTagged) {
    return String(v.value);
  }
  if (v instanceof EdnKeyword) {
    return v.value;
  }
  if (Array.isArray(v)) {
    // [:build/page {...}] — a page/date reference wrapped in a vector
    if (v.length === 2 && v[0] instanceof EdnKeyword && v[0].value === 'build/page' && v[1] instanceof Map) {
      const innerMap = v[1];
      const title = asString(mapGet(innerMap, 'block/title'));
      const journal = mapGet(innerMap, 'build/journal');
      const dateStr = journalFieldToDate(journal);
      if (dateStr) return { __type: 'date-ref', date: dateStr };
      if (title) {
        const detected = detectDateFromTitle(title);
        if (detected) return { __type: 'date-ref', date: detected };
        // Extract build/tags if present (e.g., [:user.class/persona-hCkxhGT8])
        const tagsVec = mapGet(innerMap, 'build/tags');
        const tags: string[] = [];
        if (Array.isArray(tagsVec)) {
          for (const t of tagsVec) {
            if (t instanceof EdnKeyword) tags.push(t.value);
          }
        }
        return { __type: 'page-ref', title, ...(tags.length > 0 ? { tags } : {}) };
      }
    }
    // [:block/uuid #uuid "..."] — a UUID reference (selection/closed value)
    if (v.length === 2 && v[0] instanceof EdnKeyword && v[0].value === 'block/uuid' && v[1] instanceof EdnTagged) {
      return { __type: 'uuid-ref', uuid: String(v[1].value) };
    }
    // Single-element vec: unwrap
    if (v.length === 1) return resolvePropertyValue(v[0]);
    return v.map(resolvePropertyValue);
  }
  if (v instanceof Map) {
    // Direct :build/page reference (not wrapped in vec)
    const title = asString(mapGet(v, 'block/title'));
    const journal = mapGet(v, 'build/journal');
    const dateStr = journalFieldToDate(journal);
    if (dateStr) return { __type: 'date-ref', date: dateStr };
    if (title) {
      const detected = detectDateFromTitle(title);
      if (detected) return { __type: 'date-ref', date: detected };
      // Extract build/tags if present
      const tagsVec = mapGet(v, 'build/tags');
      const tags: string[] = [];
      if (Array.isArray(tagsVec)) {
        for (const t of tagsVec) {
          if (t instanceof EdnKeyword) tags.push(t.value);
        }
      }
      return { __type: 'page-ref', title, ...(tags.length > 0 ? { tags } : {}) };
    }
    return Object.fromEntries(
      [...v.entries()].map(([mk, mv]) => [
        mk instanceof EdnKeyword ? mk.value : String(mk),
        resolvePropertyValue(mv),
      ])
    );
  }
  return v;
}

/**
 * Parse raw Logseq EDN text and return a structured LogseqExport.
 * Throws on invalid input.
 */
export function parseLogseqEdn(raw: string): LogseqExport {
  const edn = parseEdn(raw);
  return ednToLogseqExport(edn);
}
