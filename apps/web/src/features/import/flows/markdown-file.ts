/**
 * markdown-file flow — the v1 `POST /import/markdown` semantics ported
 * (spec §2): frontmatter (the @notees/export grammar) drives identity,
 * classes, node fields, and typed properties; the title precedence is
 * frontmatter `title` → `name` → the first `# ` heading → "Untitled"; the
 * body appends as ONE child block, markdown-inline parsed; the frontmatter
 * uuid is honored through a client-supplied id with the v1 conflict modes
 * (`block` fails loud, `return_existing` reports the existing node).
 * Everything writes through the ordinary client op path.
 *
 * Fail loud per the spec: invalid YAML, an unknown class, and a blocked
 * uuid conflict throw; an un-preparable property value lands in the
 * warning list and the import continues (never fatal).
 */

import {
  markdownBlockAst,
  normalizeMetadata,
  parseFrontmatter,
} from "@notees/export";

import type { AnyClient } from "../../collection/types.js";
import type { ClientPropertySchema } from "@/core/workspace-client/index.js";
import { coerceImportValue, createNodeWithId, writePropertyValue } from "../import-writes.js";

export interface ImportMarkdownFileInput {
  /** The file's text content. */
  content: string;
  /** v1 conflict mode for a frontmatter uuid that already exists. */
  uuidConflictMode?: "block" | "return_existing";
}

export interface ImportedNodeEntry {
  id: string;
  title: string;
}

export interface MarkdownFileReport {
  created: ImportedNodeEntry[];
  existing: ImportedNodeEntry[];
  /** Un-preparable property values and skipped node fields — never fatal. */
  warnings: string[];
}

interface NameUuid {
  name: string | null;
  uuid: string | null;
}

function unpackNameUuid(entry: unknown): NameUuid {
  if (typeof entry === "string") return { name: entry, uuid: null };
  if (typeof entry === "object" && entry !== null) {
    const record = entry as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : null,
      uuid: typeof record.uuid === "string" ? record.uuid : null,
    };
  }
  return { name: null, uuid: null };
}

function titleTextOf(client: AnyClient, nodeId: string): string {
  const node = client.getNode(nodeId) ?? client.getNodeRaw(nodeId);
  if (node === undefined) return "Untitled";
  const text = node.contentAst.map((token) => ("text" in token ? token.text : "")).join("");
  return text.trim() === "" ? "Untitled" : text;
}

/** v1 `_extract_title`: frontmatter title → name → first `# ` heading → Untitled. */
export function extractMarkdownTitle(metadata: Record<string, unknown>, body: string): string {
  if ("title" in metadata && metadata.title !== null) return String(metadata.title);
  if ("name" in metadata && metadata.name !== null) return String(metadata.name);
  const firstLine = body.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.startsWith("# ")) return firstLine.slice(2).trim();
  return "Untitled";
}

export async function importMarkdownFile(
  client: AnyClient,
  input: ImportMarkdownFileInput,
): Promise<MarkdownFileReport> {
  const mode = input.uuidConflictMode ?? "block";
  const { metadata: rawMetadata, body } = parseFrontmatter(input.content);
  const metadata = normalizeMetadata(rawMetadata);
  const report: MarkdownFileReport = { created: [], existing: [], warnings: [] };

  const title = extractMarkdownTitle(metadata, body);

  // Identity: the frontmatter uuid rides a client-supplied id; conflicts
  // answer the v1 conflict mode (block = fail loud).
  let id: string | undefined;
  if (metadata.uuid !== undefined && metadata.uuid !== null) {
    const uuid = String(metadata.uuid);
    if (client.getNodeRaw(uuid) !== undefined) {
      if (mode === "block") {
        throw new Error(`Node with UUID ${uuid} already exists`);
      }
      report.existing.push({ id: uuid, title: titleTextOf(client, uuid) });
      return report;
    }
    id = uuid;
  }

  // Classes: uuid or case-insensitive name; unknown fails loud (spec §2).
  const classIds: string[] = [];
  if (metadata.classes !== undefined && Array.isArray(metadata.classes)) {
    const classes = client.listClasses();
    const byName = new Map<string, string>();
    for (const cls of classes) {
      const name = titleTextOf(client, cls.id);
      const key = name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, cls.id);
    }
    for (const entry of metadata.classes) {
      const { name, uuid } = unpackNameUuid(entry);
      const classId =
        (uuid !== null && classes.some((cls) => cls.id === uuid) ? uuid : null) ??
        (name !== null ? (byName.get(name.trim().toLowerCase()) ?? null) : null);
      if (classId === null) {
        throw new Error(`Unknown class: ${name ?? uuid ?? JSON.stringify(entry)}`);
      }
      classIds.push(classId);
    }
  }

  // Tags: resolved to existing nodes by uuid/name; an unknown tag name
  // creates a stub page for it (the v1 `_resolve_tags` semantics).
  const tagIds: string[] = [];
  if (metadata.tags !== undefined && Array.isArray(metadata.tags)) {
    for (const entry of metadata.tags) {
      const { name, uuid } = unpackNameUuid(entry);
      let tagId: string | null = null;
      if (uuid !== null && client.getNodeRaw(uuid) !== undefined) tagId = uuid;
      if (tagId === null && name !== null) {
        const found = client.resolveNodeByName(name);
        if (found !== null) tagId = found;
      }
      if (tagId === null && name !== null) {
        tagId = await createNodeWithId(client, { name, isEmbedded: false });
      }
      if (tagId === null) {
        throw new Error(`Tag could not be resolved: ${JSON.stringify(entry)}`);
      }
      tagIds.push(tagId);
    }
  }

  const isPage = metadata.is_page === undefined ? true : Boolean(metadata.is_page);
  const nodeId = await createNodeWithId(client, {
    ...(id !== undefined ? { id } : {}),
    name: title,
    ...(classIds.length > 0 ? { classIds } : {}),
    ...(tagIds.length > 0 ? { tagIds } : {}),
    // v1 is_page=false → the Block role; a parentless embedded block.
    ...(isPage ? { isEmbedded: false } : { isEmbedded: true }),
  });
  report.created.push({ id: nodeId, title });

  // Node fields (icon/color) ride object.update — createObject carries no
  // node fields, updateObject does (the UpdateObjectInput contract).
  const icon = metadata.icon !== undefined && metadata.icon !== null ? String(metadata.icon) : null;
  const color = metadata.color !== undefined && metadata.color !== null ? String(metadata.color) : null;
  if (icon !== null || color !== null) {
    await client.updateObject(nodeId, {
      ...(icon !== null ? { icon } : {}),
      ...(color !== null ? { color } : {}),
    });
  }

  // Frontmatter properties → schemas matched by name; values coerced per
  // schema type; un-preparable values warn and never abort (spec §2).
  if (
    metadata.properties !== undefined &&
    typeof metadata.properties === "object" &&
    metadata.properties !== null
  ) {
    const schemas = client.listPropertySchemas();
    const byName = new Map<string, ClientPropertySchema>();
    for (const schema of schemas) {
      const key = schema.name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, schema);
    }
    for (const [rawName, rawValue] of Object.entries(metadata.properties)) {
      const schema = byName.get(rawName.trim().toLowerCase());
      if (schema === undefined) {
        report.warnings.push(`No property named "${rawName}" — value skipped`);
        continue;
      }
      const coerced = await coerceImportValue(client, schema, rawValue);
      if (!coerced.ok) {
        report.warnings.push(`Property "${rawName}": ${coerced.error} — value skipped`);
        continue;
      }
      await writePropertyValue(client, nodeId, schema, coerced.value, 0);
    }
  }

  // The body appends as ONE child block, markdown-inline parsed.
  const bodyAst = markdownBlockAst(body);
  if (bodyAst.length > 0) {
    await createNodeWithId(client, { parentId: nodeId, contentAst: bodyAst });
  }

  return report;
}
