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
  tags?: string[];      // class ids
  properties?: Record<string, unknown>;
  blocks: LogseqBlock[];
}

export interface LogseqExport {
  pages: LogseqPage[];
  properties: LogseqProperty[];
  classes: LogseqClass[];
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
      const typeKw = mapGet(v, 'logseq.property/type');
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

  // ── Pages & Blocks ───────────────────────────────
  const pagesVec = mapGet(edn, 'pages-and-blocks');
  const pages: LogseqPage[] = [];
  if (Array.isArray(pagesVec)) {
    for (const entry of pagesVec) {
      if (!(entry instanceof Map)) continue;
      const pageMap = mapGet(entry, 'page');
      if (!pageMap || !(pageMap instanceof Map)) continue;

      const title = asString(mapGet(pageMap, 'block/title')) ?? '';
      const uuidTagged = mapGet(pageMap, 'block/uuid');
      const uuid = uuidTagged instanceof EdnTagged ? String(uuidTagged.value) : undefined;

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
      if (propsOnPage instanceof Map) {
        for (const [pk, pv] of propsOnPage.entries()) {
          if (!(pk instanceof EdnKeyword)) continue;
          // Skip logseq system properties
          if (pk.value.startsWith('logseq.property')) continue;
          pageProperties[pk.value] = resolvePropertyValue(pv);
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
        tags: tags.length > 0 ? tags : undefined,
        properties: Object.keys(pageProperties).length > 0 ? pageProperties : undefined,
        blocks,
      });
    }
  }

  return { pages, properties, classes };
}

// ── Internal helpers ───────────────────────────────────────────

function asString(v: EdnValue | undefined): string | null {
  if (typeof v === 'string') return v;
  return null;
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
      if (pk.value.startsWith('logseq.property')) continue;
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
      if (title) return { __type: 'page-ref', title };
      const journal = mapGet(innerMap, 'build/journal');
      if (typeof journal === 'number') {
        const s = String(journal);
        if (s.length === 8) return { __type: 'date-ref', date: `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` };
        return { __type: 'date-ref', date: s };
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
    if (title) return { __type: 'page-ref', title };
    const journal = mapGet(v, 'build/journal');
    if (typeof journal === 'number') {
      const s = String(journal);
      if (s.length === 8) return { __type: 'date-ref', date: `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` };
      return s;
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
