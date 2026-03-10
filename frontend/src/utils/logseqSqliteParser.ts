/**
 * Parser for Logseq SQLite database exports (DB-based graph format).
 *
 * Logseq's DB format stores everything in a single `kvs` table using
 * Transit+JSON encoded Datascript datoms (Entity-Attribute-Value triples).
 *
 * This parser:
 * 1. Opens the SQLite file using sql.js (WASM)
 * 2. Reads all KVS rows containing entity data ("~:keys" chunks)
 * 3. Decodes Transit+JSON with proper cache reference handling
 * 4. Reconstructs entities from datoms
 * 5. Converts to LogseqExport interface (same as EDN parser output)
 *
 * The resulting LogseqExport can be fed directly into ImportLogseqModal's
 * 7-phase import pipeline.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error sql.js has no type declarations
import initSqlJs, { type Database } from 'sql.js';
import type {
  LogseqExport,
  LogseqPage,
  LogseqBlock,
  LogseqClass,
  LogseqProperty,
  LogseqSelectionOption,
} from './ednParser';

// ── Transit+JSON Decoder ─────────────────────────────────────────

/**
 * Minimal Transit+JSON decoder that handles Logseq's serialization format.
 *
 * Transit uses caching for map keys: the first time a key string appears it's
 * stored in a per-chunk cache, and subsequent references use "^N" shorthand
 * (base-44 encoded index).
 */
class TransitDecoder {
  private keyCache: string[] = [];

  /**
   * Parse a KVS content string and extract datoms: [eid, attribute, value].
   * Each chunk is a Transit map with a ":keys" entry containing datom arrays.
   */
  parseDatomChunk(content: string): Array<[number, string, unknown]> {
    this.keyCache = [];
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      return [];
    }

    if (!Array.isArray(data) || data.length < 2 || data[0] !== '^ ') return [];

    // Find the :keys entry in the Transit map
    let keysData: unknown[] | null = null;
    for (let i = 1; i < data.length - 1; i += 2) {
      const key = this.resolveKey(data[i] as string);
      if (key === 'keys') {
        keysData = data[i + 1] as unknown[];
        break;
      }
    }

    if (!keysData || !Array.isArray(keysData)) return [];

    const datoms: Array<[number, string, unknown]> = [];
    for (const datom of keysData) {
      if (!Array.isArray(datom) || datom.length < 3) continue;
      const eid = datom[0] as number;
      const attr = this.resolveKey(datom[1] as string);
      const value = this.resolveValue(datom[2]);
      datoms.push([eid, attr, value]);
    }
    return datoms;
  }

  /** Resolve a Transit map key (keyword or cache reference). */
  private resolveKey(raw: string): string {
    if (typeof raw !== 'string') return String(raw);
    if (raw.startsWith('~:')) {
      const decoded = raw.slice(2);
      this.keyCache.push(decoded);
      return decoded;
    }
    if (raw.startsWith('^')) {
      const idx = cacheIndex(raw.slice(1));
      if (idx !== null && idx < this.keyCache.length) {
        return this.keyCache[idx];
      }
      return raw; // unresolved reference
    }
    this.keyCache.push(raw);
    return raw;
  }

  /** Resolve a Transit value (keyword, UUID, integer, nested map/list). */
  private resolveValue(raw: unknown): unknown {
    if (typeof raw === 'string') {
      if (raw.startsWith('~:')) return raw.slice(2);
      if (raw.startsWith('~u')) return raw.slice(2);
      if (raw.startsWith('~i')) {
        const n = parseInt(raw.slice(2), 10);
        return isNaN(n) ? raw : n;
      }
      if (raw.startsWith('^')) {
        const idx = cacheIndex(raw.slice(1));
        if (idx !== null && idx < this.keyCache.length) {
          return this.keyCache[idx];
        }
        return raw;
      }
      return raw;
    }
    if (Array.isArray(raw)) {
      if (raw.length >= 1 && raw[0] === '^ ') {
        // Nested Transit map
        const result: Record<string, unknown> = {};
        for (let j = 1; j < raw.length - 1; j += 2) {
          const k = this.resolveKey(raw[j] as string);
          const v = this.resolveValue(raw[j + 1]);
          result[k] = v;
        }
        return result;
      }
      return raw.map((item) => this.resolveValue(item));
    }
    return raw;
  }
}

/** Convert Transit cache reference to integer index (base-44 encoding). */
const CACHE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function cacheIndex(ref: string): number | null {
  if (ref.length === 1) {
    const idx = CACHE_CHARS.indexOf(ref);
    return idx >= 0 ? idx : null;
  }
  if (ref.length === 2) {
    const c1 = CACHE_CHARS.indexOf(ref[0]);
    const c2 = CACHE_CHARS.indexOf(ref[1]);
    if (c1 >= 0 && c2 >= 0) {
      return c1 * CACHE_CHARS.length + c2 + CACHE_CHARS.length;
    }
  }
  return null;
}

// ── Entity reconstruction ────────────────────────────────────────

/** Attributes that accumulate multiple values from separate datoms. */
const MULTI_VALUE_ATTRS = new Set([
  'block/refs',
  'block/path-refs',
  'block/tags',
  'logseq.property.class/properties',  // properties assigned to a class (one datom per property)
  'logseq.property/classes',           // class filters on a node-type property
]);

interface RawEntity {
  [attr: string]: unknown;
}

/**
 * Parse all KVS rows and reconstruct entities from datoms.
 * Returns a map of entity-id → attribute map.
 */
function reconstructEntities(db: Database): Map<number, RawEntity> {
  const entities = new Map<number, RawEntity>();
  const multiValues = new Map<number, Map<string, unknown[]>>();
  const decoder = new TransitDecoder();

  const stmt = db.prepare("SELECT content FROM kvs WHERE content LIKE '%~:keys%'");
  while (stmt.step()) {
    const content = stmt.get()[0] as string;
    const datoms = decoder.parseDatomChunk(content);
    for (const [eid, attr, value] of datoms) {
      if (MULTI_VALUE_ATTRS.has(attr)) {
        if (!multiValues.has(eid)) multiValues.set(eid, new Map());
        const mv = multiValues.get(eid)!;
        if (!mv.has(attr)) mv.set(attr, []);
        mv.get(attr)!.push(value);
      } else {
        if (!entities.has(eid)) entities.set(eid, {});
        entities.get(eid)![attr] = value;
      }
    }
  }
  stmt.free();

  // Merge multi-value attributes (deduplicated)
  for (const [eid, attrs] of multiValues) {
    if (!entities.has(eid)) entities.set(eid, {});
    const entity = entities.get(eid)!;
    for (const [attr, values] of attrs) {
      entity[attr] = [...new Set(values)];
    }
  }

  return entities;
}

// ── LogseqExport builder ─────────────────────────────────────────

/** Well-known Logseq class entity IDs. */
const LOGSEQ_CLASS = {
  ROOT: 1,
  TAG: 2,
  PROPERTY: 3,
  TEMPLATE: 4,
  PAGE: 135,
  JOURNAL: 136,
  WHITEBOARD: 137,
  TASK: 138,
  QUERY: 139,
  CARD: 140,
  CARDS: 141,
  ASSET: 142,
  CODE: 143,
  QUOTE: 144,
  MATH: 145,
  PDF_ANNOTATION: 146,
} as const;

/** Logseq system properties that are whitelisted for import. */
const LOGSEQ_PROPERTY_WHITELIST = new Set([
  'logseq.property/description',
  'logseq.property/status',
  'logseq.property/priority',
]);

/** Logseq property type → type string (matching EDN parser output format). */
function mapPropertyType(rawType: unknown): string {
  const t = String(rawType);
  switch (t) {
    case 'node': return 'node';
    case 'date': return 'date';
    case 'number': return 'number';
    case 'checkbox': return 'checkbox';
    case 'entity': return 'node';
    default: return 'default';
  }
}

/** Minimum length for a valid UUID (32 hex chars without dashes). */
const MIN_UUID_LENGTH = 32;

/** Check whether a string looks like a valid UUID (32-36 chars, hex+dashes). */
function isValidUuid(s: string): boolean {
  return s.length >= MIN_UUID_LENGTH && s.length <= 36 && /^[0-9a-f-]+$/i.test(s);
}

/**
 * Convert YYYYMMDD integer to YYYY-MM-DD string.
 * Returns `undefined` if the value does not encode a valid calendar date.
 */
function journalDayToDate(day: number): string | undefined {
  const s = String(day);
  if (s.length !== 8) return undefined;
  const yyyy = s.slice(0, 4);
  const mm   = s.slice(4, 6);
  const dd   = s.slice(6, 8);
  const month = Number(mm);
  const dayN  = Number(dd);
  if (month < 1 || month > 12 || dayN < 1 || dayN > 31) return undefined;
  // Final validation via Date constructor
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  if (isNaN(d.getTime())) return undefined;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convert reconstructed entities into a LogseqExport that can be consumed
 * by ImportLogseqModal's 7-phase pipeline.
 */
function buildLogseqExport(entities: Map<number, RawEntity>): LogseqExport {
  // Build eid→UUID lookup (skip invalid UUIDs — short Transit artefacts like "a1V")
  const eidToUuid = new Map<number, string>();
  for (const [eid, attrs] of entities) {
    const uuid = attrs['block/uuid'];
    if (typeof uuid === 'string' && isValidUuid(uuid)) {
      eidToUuid.set(eid, uuid);
    }
  }

  // Build eid→title lookup (for resolving property value references)
  const eidToTitle = new Map<number, string>();
  for (const [eid, attrs] of entities) {
    const title = attrs['block/title'] ?? attrs['block/name'];
    if (typeof title === 'string') eidToTitle.set(eid, title);
  }

  // ── Classify entities ──────────────────────────────────────

  const classEntities = new Map<number, RawEntity>();
  const propertyEntities = new Map<number, RawEntity>();
  const pageEntities = new Map<number, RawEntity>();
  const blockEntities = new Map<number, RawEntity>();

  for (const [eid, attrs] of entities) {
    const ident = String(attrs['db/ident'] ?? '');
    const tags = attrs['block/tags'];
    const tagList = Array.isArray(tags) ? tags as number[] : (typeof tags === 'number' ? [tags] : []);

    // Skip KV entries and internal entities
    if ('kv/value' in attrs) continue;
    if (ident.startsWith('logseq.kv/')) continue;

    // Skip asset-only entities early
    if ('logseq.property.asset/type' in attrs) continue;
    if (tagList.includes(LOGSEQ_CLASS.ASSET) && tagList.length === 1) continue;

    // Classes: user-defined or logseq built-in (skip Root, Tag, Property meta-classes)
    if (ident.startsWith('user.class/') ||
        (ident.startsWith('logseq.class/') && ![LOGSEQ_CLASS.ROOT, LOGSEQ_CLASS.TAG, LOGSEQ_CLASS.PROPERTY].includes(eid as 1 | 2 | 3))) {
      classEntities.set(eid, attrs);
      continue;
    }

    // Properties: user-defined or whitelisted system properties
    if (ident.startsWith('user.property/') || LOGSEQ_PROPERTY_WHITELIST.has(ident)) {
      propertyEntities.set(eid, attrs);
      continue;
    }

    // Skip other system/internal entities with db/ident
    if (ident) continue;

    // Journal pages
    if ('block/journal-day' in attrs) {
      pageEntities.set(eid, attrs);
      continue;
    }

    // Pages: have block/name, tagged as Page (135) or other class, NOT a child block
    if ('block/name' in attrs && !('block/parent' in attrs)) {
      pageEntities.set(eid, attrs);
      continue;
    }

    // Blocks: have block/parent (child nodes)
    if ('block/parent' in attrs) {
      blockEntities.set(eid, attrs);
      continue;
    }
  }

  // ── Build classes ──────────────────────────────────────────

  const classes: LogseqClass[] = [];
  const classEidToId = new Map<number, string>();

  for (const [eid, attrs] of classEntities) {
    const ident = String(attrs['db/ident'] ?? '');
    const title = String(attrs['block/title'] ?? attrs['block/name'] ?? ident);
    const uuid = eidToUuid.get(eid);

    // Map the extends relationship
    const extendsEid = attrs['logseq.property.class/extends'];
    let extendsId: string | undefined;
    if (typeof extendsEid === 'number') {
      const parentEntity = entities.get(extendsEid);
      if (parentEntity) {
        extendsId = String(parentEntity['db/ident'] ?? '');
      }
    }

    // Collect properties assigned to this class
    const classProps = attrs['logseq.property.class/properties'];
    let properties: string[] | undefined;
    if (Array.isArray(classProps)) {
      properties = classProps
        .map((propEid: unknown) => {
          if (typeof propEid !== 'number') return null;
          const propEntity = entities.get(propEid);
          return propEntity ? String(propEntity['db/ident'] ?? '') : null;
        })
        .filter((id): id is string => id !== null);
    }

    const cls: LogseqClass = { id: ident || `eid:${eid}`, title };
    if (uuid) cls.uuid = uuid;
    if (extendsId) cls.extends = extendsId;
    if (properties?.length) cls.properties = properties;

    classes.push(cls);
    classEidToId.set(eid, cls.id);
  }

  // Also map built-in classes for tag resolution
  for (const [eid, attrs] of entities) {
    const ident = String(attrs['db/ident'] ?? '');
    if (ident.startsWith('logseq.class/')) {
      classEidToId.set(eid, ident);
    }
  }

  // ── Build properties ───────────────────────────────────────

  // Pre-build reverse index: property eid → closed-value entities (O(n) instead of O(n²))
  const closedValuesByProp = new Map<number, Array<{ eid: number; attrs: RawEntity }>>();
  for (const [cvEid, cvAttrs] of entities) {
    const propEid = cvAttrs['block/closed-value-property'];
    if (typeof propEid === 'number') {
      if (!closedValuesByProp.has(propEid)) closedValuesByProp.set(propEid, []);
      closedValuesByProp.get(propEid)!.push({ eid: cvEid, attrs: cvAttrs });
    }
  }

  // Collect user property idents for later use when extracting property values
  const userPropertyIdents = new Map<string, number>(); // ident → eid

  const properties: LogseqProperty[] = [];

  for (const [eid, attrs] of propertyEntities) {
    const ident = String(attrs['db/ident'] ?? '');
    const title = String(attrs['block/title'] ?? attrs['block/name'] ?? ident);
    const rawType = attrs['logseq.property/type'] ?? 'default';
    const cardinality = String(attrs['db/cardinality'] ?? 'db.cardinality/one');

    if (ident.startsWith('user.property/')) {
      userPropertyIdents.set(ident, eid);
    }

    // Collect selection options (closed values) using pre-built reverse index
    const selectionOptions: LogseqSelectionOption[] = [];
    const closedValues = closedValuesByProp.get(eid);
    if (closedValues) {
      for (const { eid: cvEid, attrs: cvAttrs } of closedValues) {
        const cvTitle = cvAttrs['block/title'] ?? cvAttrs['block/name'];
        const cvUuid = eidToUuid.get(cvEid);
        if (cvTitle != null) {
          selectionOptions.push({
            value: String(cvTitle),
            uuid: cvUuid,
          });
        }
      }
    }

    // Collect class filters (for node-type properties)
    // In the DB format these are stored in logseq.property/classes
    const classFiltersRaw = attrs['logseq.property/classes'];
    let classFilters: string[] | undefined;
    if (Array.isArray(classFiltersRaw)) {
      classFilters = classFiltersRaw
        .map((ceid: unknown) => typeof ceid === 'number' ? classEidToId.get(ceid) : undefined)
        .filter((id): id is string => id !== undefined);
    }

    const prop: LogseqProperty = {
      id: ident,
      title,
      type: mapPropertyType(rawType),
      cardinality: cardinality,
    };
    if (classFilters?.length) prop.classFilters = classFilters;
    if (selectionOptions.length > 0) prop.selectionOptions = selectionOptions;

    properties.push(prop);
  }

  // ── Build pages and blocks ─────────────────────────────────

  // First, build block tree per page
  // block/page → eid of the page entity
  // block/parent → eid of the parent (page or another block)
  // block/order → lexicographic sort key

  // Group blocks by page
  const blocksByPage = new Map<number, Map<number, RawEntity & { eid: number }>>();

  for (const [eid, attrs] of blockEntities) {
    const pageEid = attrs['block/page'] as number | undefined;
    if (pageEid == null) continue;
    if (!blocksByPage.has(pageEid)) blocksByPage.set(pageEid, new Map());
    blocksByPage.get(pageEid)!.set(eid, { ...attrs, eid });
  }

  /**
   * Resolve a property value from a raw entity attribute.
   * Entity ID references are converted to page-ref markers.
   */
  function resolvePropertyValue(value: unknown, propType: string): unknown {
    if (typeof value === 'number' && (propType === 'node' || propType === 'entity')) {
      // Entity ID reference → page-ref / uuid-ref marker
      const refUuid = eidToUuid.get(value);
      const refTitle = eidToTitle.get(value);
      if (refUuid) {
        // Include title for fallback resolution in case the UUID isn't imported
        return { __type: 'uuid-ref', uuid: refUuid, ...(refTitle ? { title: refTitle } : {}) };
      }
      if (refTitle) {
        return { __type: 'page-ref', title: refTitle };
      }
      return value;
    }
    if (typeof value === 'number' && propType === 'date') {
      // Date references point to journal day entities
      const dateEntity = entities.get(value);
      if (dateEntity && 'block/journal-day' in dateEntity) {
        const dateStr = journalDayToDate(dateEntity['block/journal-day'] as number);
        if (dateStr) return { __type: 'date-ref', date: dateStr };
      }
      // Might be a direct reference to a date page
      const dateUuid = eidToUuid.get(value);
      if (dateUuid) {
        return { __type: 'uuid-ref', uuid: dateUuid };
      }
      return value;
    }
    // Selection/closed-value references
    if (typeof value === 'number') {
      const refEntity = entities.get(value);
      if (refEntity) {
        const refUuid = eidToUuid.get(value);
        if (refUuid && refEntity['block/closed-value-property'] != null) {
          return { __type: 'uuid-ref', uuid: refUuid };
        }
        // General entity reference
        if (refUuid) {
          const refTitle = eidToTitle.get(value);
          return { __type: 'uuid-ref', uuid: refUuid, ...(refTitle ? { title: refTitle } : {}) };
        }
        const refTitle = eidToTitle.get(value);
        if (refTitle) {
          return { __type: 'page-ref', title: refTitle };
        }
      }
    }
    return value;
  }

  /** Extract user property values from an entity. */
  function extractProperties(attrs: RawEntity): Record<string, unknown> | undefined {
    const props: Record<string, unknown> = {};
    let found = false;

    for (const [ident, propEid] of userPropertyIdents) {
      if (ident in attrs) {
        const propEntity = entities.get(propEid);
        const propType = propEntity ? mapPropertyType(propEntity['logseq.property/type'] ?? 'default') : 'default';
        props[ident] = resolvePropertyValue(attrs[ident], propType);
        found = true;
      }
    }

    // Also check whitelisted system properties
    for (const sysIdent of LOGSEQ_PROPERTY_WHITELIST) {
      if (sysIdent in attrs) {
        const raw = attrs[sysIdent];
        // Status and priority are entity refs to closed values
        if (typeof raw === 'number') {
          const refTitle = eidToTitle.get(raw);
          if (refTitle) {
            props[sysIdent] = refTitle;
          }
        } else {
          props[sysIdent] = raw;
        }
        found = true;
      }
    }

    return found ? props : undefined;
  }

  /** Build a LogseqBlock tree for a set of blocks belonging to one page. */
  function buildBlockTree(pageEid: number): LogseqBlock[] {
    const pageBlocks = blocksByPage.get(pageEid);
    if (!pageBlocks) return [];

    // Group children by parent and sort by block/order
    const childrenOf = new Map<number, Array<{ eid: number; attrs: RawEntity }>>();

    for (const [eid, attrs] of pageBlocks) {
      const parentEid = attrs['block/parent'] as number;
      if (!childrenOf.has(parentEid)) childrenOf.set(parentEid, []);
      childrenOf.get(parentEid)!.push({ eid, attrs });
    }

    // Sort each group by block/order (lexicographic)
    for (const children of childrenOf.values()) {
      children.sort((a, b) => {
        const oa = String(a.attrs['block/order'] ?? '');
        const ob = String(b.attrs['block/order'] ?? '');
        return oa.localeCompare(ob);
      });
    }

    /** Recursively build block tree starting from a parent. */
    function buildChildren(parentEid: number): LogseqBlock[] {
      const children = childrenOf.get(parentEid);
      if (!children) return [];

      return children.map(({ eid, attrs }) => {
        const title = String(attrs['block/title'] ?? '');
        const uuid = eidToUuid.get(eid);

        // Tags (class references)
        const tagEids = attrs['block/tags'];
        const tagList = Array.isArray(tagEids) ? tagEids as number[] : [];
        const tags = tagList
          .map((t) => classEidToId.get(t))
          .filter((id): id is string => id !== undefined);

        const properties = extractProperties(attrs);

        const block: LogseqBlock = { title };
        if (uuid) block.uuid = uuid;
        if (tags.length > 0) block.tags = tags;
        if (properties) block.properties = properties;

        const childBlocks = buildChildren(eid);
        if (childBlocks.length > 0) block.children = childBlocks;

        return block;
      });
    }

    // Top-level blocks are children of the page entity itself
    return buildChildren(pageEid);
  }

  // ── Assemble pages ─────────────────────────────────────────

  const pages: LogseqPage[] = [];

  // Skip internal/system pages
  const SKIP_PAGE_NAMES = new Set([
    'contents', '$$$views', '$$$favorites',
  ]);

  /**
   * Walk the logseq.property/parent chain to reconstruct the full namespace
   * path for a page entity (e.g. "https:/forums/developer.legrand.com").
   */
  function getFullNamespacePath(eid: number, visited = new Set<number>()): string {
    if (visited.has(eid)) return ''; // cycle guard
    visited.add(eid);
    const a = entities.get(eid);
    if (!a) return '';
    const t = String(a['block/title'] ?? a['block/name'] ?? '');
    const parentEid = a['logseq.property/parent'];
    if (typeof parentEid === 'number') {
      const parentPath = getFullNamespacePath(parentEid, visited);
      return parentPath ? `${parentPath}/${t}` : t;
    }
    return t;
  }

  for (const [eid, attrs] of pageEntities) {
    const name = String(attrs['block/name'] ?? '');
    const title = String(attrs['block/title'] ?? attrs['block/name'] ?? '');

    // Skip system pages
    if (SKIP_PAGE_NAMES.has(name)) continue;

    // Skip URL namespace pages: Logseq splits URLs like https://example.com/path
    // into separate namespace pages ("https:", "example.com", "path") connected
    // via logseq.property/parent. Detect by reconstructing the full path and
    // checking if it starts with a URL scheme.
    const fullNamespacePath = getFullNamespacePath(eid);
    if (/^https?:/i.test(fullNamespacePath)) continue;

    // Skip asset entities
    if ('logseq.property.asset/type' in attrs) continue;

    // Skip pages tagged only as Asset
    const tagEids = attrs['block/tags'];
    const tagList = Array.isArray(tagEids) ? tagEids as number[] : (typeof tagEids === 'number' ? [tagEids] : []);
    if (tagList.includes(LOGSEQ_CLASS.ASSET) && tagList.length === 1) continue;

    const uuid = eidToUuid.get(eid);
    const journalDay = attrs['block/journal-day'] as number | undefined;

    // Tags (class refs, excluding Page/Journal base classes)
    const tags = tagList
      .filter((t) => t !== LOGSEQ_CLASS.PAGE && t !== LOGSEQ_CLASS.JOURNAL)
      .map((t) => classEidToId.get(t))
      .filter((id): id is string => id !== undefined);

    // Aliases
    const aliasRefs = attrs['block/alias'];
    let aliasOfUuids: string[] | undefined;
    if (Array.isArray(aliasRefs)) {
      aliasOfUuids = aliasRefs
        .map((ref: unknown) => typeof ref === 'number' ? eidToUuid.get(ref) : undefined)
        .filter((u): u is string => u !== undefined);
    } else if (typeof aliasRefs === 'number') {
      const u = eidToUuid.get(aliasRefs);
      if (u) aliasOfUuids = [u];
    }

    // Parent page (namespace hierarchy)
    const parentEid = attrs['logseq.property/parent'];
    let parent: string | undefined;
    if (typeof parentEid === 'number') {
      parent = eidToTitle.get(parentEid);
    }

    const properties = extractProperties(attrs);
    const blocks = buildBlockTree(eid);

    // Extract page icon from logseq.property/icon and convert mdi:kebab-name → mdiCamelName
    let pageIcon: string | undefined;
    const rawIcon = attrs['logseq.property/icon'];
    if (typeof rawIcon === 'string' && rawIcon) {
      if (rawIcon.startsWith('mdi:')) {
        const name = rawIcon.slice(4);
        pageIcon = 'mdi' + name.charAt(0).toUpperCase() + name.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      } else {
        pageIcon = rawIcon;
      }
    }

    const page: LogseqPage = {
      title: title || name,
      blocks,
    };
    if (uuid) page.uuid = uuid;
    const journalDateStr = journalDay ? journalDayToDate(journalDay) : undefined;
    if (journalDateStr) page.journal = journalDateStr;
    if (pageIcon) page.icon = pageIcon;
    if (tags.length > 0) page.tags = tags;
    if (aliasOfUuids?.length) page.aliasOfUuids = aliasOfUuids;
    if (parent) page.parent = parent;
    if (properties) page.properties = properties;

    pages.push(page);
  }

  return { pages, properties, classes };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Parse a Logseq SQLite database file and return a LogseqExport.
 *
 * @param buffer - The raw bytes of the .sqlite file (ArrayBuffer or Uint8Array)
 * @returns LogseqExport compatible with ImportLogseqModal
 */
export async function parseLogseqSqlite(buffer: ArrayBuffer | Uint8Array): Promise<LogseqExport> {
  // Initialize sql.js with WASM served from public/
  const SQL = await initSqlJs({
    locateFile: () => '/sql-wasm.wasm',
  });

  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const db = new SQL.Database(uint8);

  try {
    // Verify this is a Logseq DB (has kvs table)
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='kvs'");
    if (tables.length === 0 || tables[0].values.length === 0) {
      throw new Error('Not a valid Logseq SQLite database (missing "kvs" table)');
    }

    const entities = reconstructEntities(db);
    if (entities.size === 0) {
      throw new Error('No entities found in the Logseq database');
    }

    return buildLogseqExport(entities);
  } finally {
    db.close();
  }
}
