/**
 * The Zotero RDF/XML export parser — the front half of the bulk importer
 * (2026-11-02, the Zotero-full-alignment slice). Dependency-free: a tiny
 * pull parser over the regular Zotero RDF serialization (pretty-printed,
 * elements line-anchored, text entity-escaped on a single line).
 *
 * Produces the ZoteroRdfItem shape the Task-6 planner consumes verbatim:
 *
 *  - every citable resource (a top-level resource carrying z:itemType other
 *    than "attachment") becomes an item;
 *  - z:Attachment and z:Collection resources are COUNTED ONLY — they never
 *    appear in items;
 *  - top-level resources without z:itemType (bib:Journal, bib:Series, …)
 *    are ancillary: kept in a resource map for dcterms:isPartOf resolution
 *    (a journalArticle's volume/issue/issn/publicationTitle live on the
 *    bib:Journal resource the item references);
 *  - unknown/irregular element CONTENT for a mapped shape THROWS naming
 *    the item URI — fail loud, never silent drop.
 *
 * The vocab table below maps Zotero's RDF terms to the Notees pool keys
 * (packages/domain SYSTEM_PROPERTY_UUIDS — the bibliographic pool). Keys
 * present in the owner's export (Mi biblioteca.rdf); unmapped regular
 * export terms (z:linkMode, dcterms:dateSubmitted metadata, vcard:*,
 * plain-text dc:subject tags, …) are tolerated and ignored — only the
 * shapes the table claims are fail-loud.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface RdfNode {
  name: string;
  attrs: Record<string, string>;
  children: RdfNode[];
  /** Concatenated character data (entity-decoded), trimmed. */
  text: string;
}

export interface ZoteroRdfCreator {
  role: "authors" | "editors" | "contributors" | "translators";
  names: string[];
}

export interface ZoteroRdfItem {
  /** rdf:about */
  uri: string;
  /** z:itemType verbatim ("journalArticle", "case", …) */
  itemType: string;
  /** z:citationKey */
  citationKey?: string;
  /** dc:title */
  title: string;
  /** vocab-mapped pool keys */
  fields: Record<string, string>;
  creators: ZoteroRdfCreator[];
  /** link:link resource URIs — report-only */
  attachmentRefs: string[];
}

export interface ZoteroRdfParseResult {
  items: ZoteroRdfItem[];
  attachments: number;
  collections: number;
}

/**
 * The vocab: Zotero-RDF term → Notees pool key. Source terms per Zotero's
 * RDF export translator (zotero/translators RDF.js); every entry observed in
 * the owner's export. Direct scalar text elements only — dc:title,
 * dc:publisher, dc:identifier, the creator Seqs, dcterms:isPartOf, and
 * link:link are structural and parsed by dedicated walkers below.
 */
const VOCAB: Record<string, string> = {
  // Dublin Core
  "dc:date": "publicationDate",
  "dcterms:abstract": "abstract",
  "dc:description": "extra",
  "dc:rights": "rights",
  // PRISM
  "prism:volume": "volume",
  "prism:number": "issue",
  "prism:edition": "edition",
  // biblio
  "bib:pages": "pages",
  // Zotero export namespace
  "z:language": "language",
  "z:PMID": "pmid",
  "z:PMCID": "pmcid",
  "z:numPages": "numPages",
  "z:shortTitle": "shortTitle",
  "z:libraryCatalog": "libraryCatalog",
  "z:authority": "court",
  "z:code": "code",
  "z:codeNumber": "codeNumber",
  "z:type": "workType",
  "z:session": "session",
  "z:url": "url",
  // dcterms
  "dcterms:dateSubmitted": "accessDate",
};

/** dcterms:alternative is Zotero's shortTitle on export — z:shortTitle wins. */
const ALT_SHORT_TITLE = "dcterms:alternative";

/** Creator container elements → role. z:presenters rides "contributors". */
const CREATOR_ROLES: Record<string, ZoteroRdfCreator["role"]> = {
  "bib:authors": "authors",
  "bib:editors": "editors",
  "bib:contributors": "contributors",
  "z:presenters": "contributors",
  "bib:translators": "translators",
  "z:translators": "translators",
};

/**
 * dcterms:isPartOf resource resolution: the REFERENCED resource's element
 * name decides which field its dc:title fills; its scalar vocab fields and
 * ISSN identifier merge into the item (the item's own values always win).
 */
const PART_OF_TITLE_FIELD: Record<string, string> = {
  "bib:Journal": "publicationTitle",
  "bib:Periodical": "publicationTitle",
  "bib:Book": "bookTitle",
  "bib:ConferenceProceedings": "proceedingsTitle",
  "bib:Series": "series",
  "bib:Website": "websiteTitle",
  "bib:Blog": "blogTitle",
};

/** dc:identifier plain-text prefixes → pool key. */
const IDENTIFIER_PREFIXES: Record<string, string> = {
  ISBN: "isbn",
  DOI: "doi",
  ISSN: "issn",
  PMID: "pmid",
};

/* ------------------------------------------------------------------ */
/* XML entities                                                        */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) throw new Error(`bad XML numeric entity &${body};`);
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw new Error(`unknown XML entity &${body};`);
    return named;
  });
}

/* ------------------------------------------------------------------ */
/* The pull parser — tokenize, then stack-build a node tree            */
/* ------------------------------------------------------------------ */

const TOKEN_RE =
  /<\?[^?]*\?>|<!--[^]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+=(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR_RE = /([\w:.-]+)=("([^"]*)"|'([^']*)')/g;

function parseDocument(xml: string): RdfNode {
  const root: RdfNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: RdfNode[] = [root];

  let pos = 0;
  for (;;) {
    if (pos >= xml.length) break;
    TOKEN_RE.lastIndex = pos;
    const match = TOKEN_RE.exec(xml);
    if (match === null || match.index !== pos) {
      throw new Error(`unparseable XML near: ${xml.slice(pos, pos + 80)}`);
    }
    pos = TOKEN_RE.lastIndex;
    const [, closing, openName, rawAttrs, selfClose, text] = match;
    const top = stack[stack.length - 1]!;

    if (closing !== undefined) {
      if (stack.length === 1) throw new Error(`unbalanced closing tag </${closing}>`);
      if (stack[stack.length - 1]!.name !== closing) {
        throw new Error(`mismatched closing tag </${closing}> (open: <${top.name}>)`);
      }
      stack.pop();
    } else if (openName !== undefined) {
      const attrs: Record<string, string> = {};
      if (rawAttrs !== undefined && rawAttrs !== "") {
        ATTR_RE.lastIndex = 0;
        for (let am = ATTR_RE.exec(rawAttrs); am !== null; am = ATTR_RE.exec(rawAttrs)) {
          attrs[am[1]!] = decodeEntities(am[3] ?? am[4] ?? "");
        }
      }
      const node: RdfNode = { name: openName, attrs, children: [], text: "" };
      top.children.push(node);
      if (selfClose !== "/") stack.push(node);
    } else if (text !== undefined) {
      top.text += text;
    }
  }

  if (stack.length !== 1) throw new Error(`unclosed tag <${stack[stack.length - 1]!.name}>`);
  return root;
}

/* ------------------------------------------------------------------ */
/* Item walking                                                        */
/* ------------------------------------------------------------------ */

function fail(uri: string, shape: string): never {
  throw new Error(`irregular RDF shape on ${uri}: ${shape}`);
}

function childText(node: RdfNode, name: string): string | undefined {
  const child = node.children.find((c) => c.name === name);
  if (child === undefined) return undefined;
  return decodeEntities(child.text).trim();
}

/** First descendant (depth-first) with the given element name. */
function descendantText(node: RdfNode, name: string): string | undefined {
  for (const child of node.children) {
    if (child.name === name) return decodeEntities(child.text).trim();
    const found = descendantText(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Set a field only when empty — the item's own values beat resolved ones. */
function fill(fields: Record<string, string>, key: string, value: string): void {
  if (fields[key] === undefined) fields[key] = value;
}

function parseIdentifier(item: RdfNode, uri: string, fields: Record<string, string>): void {
  const text = decodeEntities(item.text).trim();

  // Shape 3: nested <dcterms:URI><rdf:value>…</rdf:value></dcterms:URI>.
  if (item.children.length > 0) {
    const uriEl = item.children[0]!;
    if (item.children.length === 1 && uriEl.name === "dcterms:URI") {
      const value = uriEl.children.length === 1 && uriEl.children[0]!.name === "rdf:value"
        ? decodeEntities(uriEl.children[0]!.text).trim()
        : undefined;
      if (value === undefined || value === "") fail(uri, "dc:identifier/dcterms:URI without rdf:value");
      fields.url = value;
      return;
    }
    fail(uri, `dc:identifier with unexpected content <${uriEl.name}>`);
  }

  if (text === "") {
    // A bare rdf:resource attribute is a URL when http(s), else irregular.
    const resource = item.attrs["rdf:resource"];
    if (resource !== undefined && /^https?:\/\//i.test(resource)) {
      fields.url = resource;
      return;
    }
    fail(uri, "empty dc:identifier");
  }

  // Shape 1: prefixed plain text ("ISBN 978-…", "DOI 10.…", "PMID 123").
  const prefixMatch = /^([A-Z]+)\s+(\S+)\s*(.*)$/.exec(text);
  if (prefixMatch !== null) {
    const key = IDENTIFIER_PREFIXES[prefixMatch[1]!];
    if (key !== undefined) {
      // A doubled ISBN line ("ISBN 978-… 978-…") yields the primary (first).
      fields[key] = prefixMatch[2]!;
      return;
    }
  }

  // Shape 2: a plain URL text.
  if (/^https?:\/\/\S+$/i.test(text)) {
    fields.url = text;
    return;
  }

  fail(uri, `unrecognized dc:identifier "${text}"`);
}

function parsePublisher(item: RdfNode, uri: string, fields: Record<string, string>): void {
  // Regular: <foaf:Organization><foaf:name>…</foaf:name></foaf:Organization>
  // (vcard:adr nested alongside). Place-only publishers — a regular Zotero
  // export shape, 106 of 376 in the owner's file — carry just
  // vcard:adr/vcard:Address/vcard:locality; the locality IS the publisher
  // text. Plain text is tolerated as the name.
  const org = item.children.find((c) => c.name === "foaf:Organization") ?? item;
  const name =
    childText(org, "foaf:name") ??
    descendantText(org, "vcard:locality") ??
    (item.children.length === 0 ? decodeEntities(item.text).trim() : undefined);
  if (name === undefined || name === "") fail(uri, "dc:publisher without foaf:name or vcard:locality");
  fields.publisher = name;
}

function parseCreators(
  container: RdfNode,
  role: ZoteroRdfCreator["role"],
  uri: string,
): ZoteroRdfCreator {
  const seq = container.children.find((c) => c.name === "rdf:Seq");
  if (seq === undefined) fail(uri, `${container.name} without rdf:Seq`);

  const names: string[] = [];
  for (const li of seq.children) {
    if (li.name !== "rdf:li") fail(uri, `unexpected <${li.name}> in ${container.name} Seq`);
    const agent = li.children[0];
    if (agent === undefined) {
      // Corporate creators ride as bare text in the li.
      const bare = decodeEntities(li.text).trim();
      if (bare !== "") {
        names.push(bare);
        continue;
      }
      fail(uri, "empty rdf:li in creators Seq");
    }
    if (agent.name === "foaf:Person") {
      const surname = childText(agent, "foaf:surname");
      if (surname === undefined || surname === "") {
        fail(uri, "foaf:Person creator without foaf:surname");
      }
      const given = childText(agent, "foaf:givenName");
      // "Family, Given"; surname-only yields the bare surname (no ", ").
      names.push(given !== undefined && given !== "" ? `${surname}, ${given}` : surname);
    } else if (agent.name === "foaf:Organization") {
      const org = childText(agent, "foaf:name");
      if (org === undefined || org === "") fail(uri, "foaf:Organization creator without foaf:name");
      names.push(org);
    } else {
      fail(uri, `unexpected creator agent <${agent.name}>`);
    }
  }

  return { role, names };
}

function isPartOfNode(node: RdfNode): RdfNode | undefined {
  return node.children.find((c) => c.name === "dcterms:isPartOf");
}

/**
 * Merge a resolved journal/book-style resource's fields into the item. Two
 * regular shapes: <dcterms:isPartOf rdf:resource="…"/> pointing at a
 * top-level resource, and the journal INLINE (<dcterms:isPartOf><bib:Journal>
 * …</bib:Journal></dcterms:isPartOf> — 410 of 638 DOI identifiers in the
 * owner's file ride this shape). An empty nested resource (the case item's
 * <bib:CourtReporter/>) is tolerated.
 */
function resolvePartOf(
  part: RdfNode,
  resources: Map<string, RdfNode>,
  fields: Record<string, string>,
): void {
  const ref = part.attrs["rdf:resource"];
  let target: RdfNode | undefined;
  if (ref !== undefined) {
    target = resources.get(ref);
  } else if (part.children.length === 1) {
    target = part.children[0];
  }
  if (target === undefined) return;

  const titleField = PART_OF_TITLE_FIELD[target.name];
  if (titleField !== undefined) {
    const title = childText(target, "dc:title");
    if (title !== undefined && title !== "") fill(fields, titleField, title);
  }
  for (const child of target.children) {
    const key = VOCAB[child.name];
    if (key !== undefined) {
      const value = decodeEntities(child.text).trim();
      if (value !== "") fill(fields, key, value);
      continue;
    }
    if (child.name === "dc:identifier") {
      const text = decodeEntities(child.text).trim();
      const prefixMatch = /^(ISSN)\s+(\S+)/.exec(text);
      // Only ISSN crosses over — a journal's own DOI is not the item's.
      if (prefixMatch !== null) fill(fields, "issn", prefixMatch[2]!);
    }
  }
}

function parseItem(resource: RdfNode, resources: Map<string, RdfNode>): ZoteroRdfItem {
  const uri = resource.attrs["rdf:about"] ?? "(no rdf:about)";

  const itemType = childText(resource, "z:itemType");
  if (itemType === undefined || itemType === "") fail(uri, "missing z:itemType");

  const title = childText(resource, "dc:title");
  if (title === undefined || title === "") fail(uri, "missing dc:title");

  const fields: Record<string, string> = {};
  const creators: ZoteroRdfCreator[] = [];
  const attachmentRefs: string[] = [];
  let citationKey: string | undefined;
  let shortTitleSeen = false;

  for (const child of resource.children) {
    if (child.name === "z:itemType" || child.name === "dc:title") continue;
    if (child.name === "z:citationKey") {
      citationKey = decodeEntities(child.text).trim();
      continue;
    }

    const role = CREATOR_ROLES[child.name];
    if (role !== undefined) {
      creators.push(parseCreators(child, role, uri));
      continue;
    }

    switch (child.name) {
      case "dc:publisher":
        parsePublisher(child, uri, fields);
        break;
      case "dc:identifier":
        parseIdentifier(child, uri, fields);
        break;
      case "dc:subject": {
        // <dc:subject><dcterms:LCC><rdf:value>… — the Library of Congress
        // call number. Plain-text subjects (tags) carry no pool field.
        const lcc = child.children[0];
        if (lcc !== undefined && lcc.name === "dcterms:LCC") {
          const value =
            lcc.children.length === 1 && lcc.children[0]!.name === "rdf:value"
              ? decodeEntities(lcc.children[0]!.text).trim()
              : undefined;
          if (value === undefined || value === "") fail(uri, "dc:subject/dcterms:LCC without rdf:value");
          fill(fields, "callNumber", value);
        }
        break;
      }
      case "dc:relation": {
        const ref = child.attrs["rdf:resource"];
        if (ref !== undefined) fields.url = ref;
        break;
      }
      case "link:link": {
        const ref = child.attrs["rdf:resource"];
        if (ref === undefined) fail(uri, "link:link without rdf:resource");
        attachmentRefs.push(ref);
        break;
      }
      case ALT_SHORT_TITLE: {
        if (!shortTitleSeen) {
          const value = decodeEntities(child.text).trim();
          if (value !== "") fill(fields, "shortTitle", value);
        }
        break;
      }
      default: {
        const key = VOCAB[child.name];
        if (key !== undefined) {
          if (key === "shortTitle") shortTitleSeen = true;
          const value = decodeEntities(child.text).trim();
          if (value !== "") fields[key] = value;
        }
        // Unmapped regular export terms are tolerated, never fatal.
      }
    }
  }

  const part = isPartOfNode(resource);
  if (part !== undefined) resolvePartOf(part, resources, fields);

  const item: ZoteroRdfItem = { uri, itemType, title, fields, creators, attachmentRefs };
  if (citationKey !== undefined && citationKey !== "") item.citationKey = citationKey;
  return item;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function parseZoteroRdf(xml: string): ZoteroRdfParseResult {
  const document = parseDocument(xml);
  const top = document.children.find((c) => c.name === "rdf:RDF") ?? document;

  // Index every top-level resource by rdf:about (ancillary resources
  // included — the journal resolution map).
  const resources = new Map<string, RdfNode>();
  for (const resource of top.children) {
    const about = resource.attrs["rdf:about"];
    if (about !== undefined) resources.set(about, resource);
  }

  const items: ZoteroRdfItem[] = [];
  let attachments = 0;
  let collections = 0;

  for (const resource of top.children) {
    if (resource.name === "z:Collection") {
      collections += 1;
      continue;
    }
    const itemType = childText(resource, "z:itemType");
    if (itemType === undefined) continue; // ancillary (bib:Journal, …)
    if (itemType === "attachment") {
      attachments += 1;
      continue;
    }
    items.push(parseItem(resource, resources));
  }

  return { items, attachments, collections };
}

/* ------------------------------------------------------------------ */
/* CLI — `tsx scripts/zotero-rdf-parser.mts <file.rdf>` prints counts   */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("usage: tsx scripts/zotero-rdf-parser.mts <file.rdf>");
    process.exitCode = 1;
    return;
  }
  const result = parseZoteroRdf(readFileSync(file, "utf8"));
  const itemTypes = new Map<string, number>();
  for (const item of result.items) {
    itemTypes.set(item.itemType, (itemTypes.get(item.itemType) ?? 0) + 1);
  }
  console.log(
    `items: ${result.items.length}, attachments: ${result.attachments}, collections: ${result.collections}`,
  );
  console.log(
    "itemTypes: " +
      [...itemTypes.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type}=${count}`)
        .join(", "),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
