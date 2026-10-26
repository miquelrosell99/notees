/**
 * Frontmatter parser — the v1 `/import/markdown` grammar ported
 * (v1-archive: app/features/import_/frontmatter_parser.py): `---` and `+++`
 * delimiters (both parsed as YAML), keys normalized to lower case, invalid
 * YAML fails loud, non-mapping YAML yields empty metadata, body left-stripped
 * of newlines only.
 */

import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^\s*(---|\+\+\+)\s*\n(.*?)\n\s*\1\s*\n?(.*)$/s;

export interface FrontmatterResult {
  metadata: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(content: string): FrontmatterResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { metadata: {}, body: content };

  const frontmatterText = match[2] ?? "";
  const body = (match[3] ?? "").replace(/^\n+/, "");
  let metadata: Record<string, unknown> = {};
  if (frontmatterText.trim()) {
    let loaded: unknown;
    try {
      loaded = parseYaml(frontmatterText);
    } catch (exc) {
      throw new Error(`Invalid frontmatter YAML: ${(exc as Error).message}`);
    }
    if (loaded !== null && typeof loaded === "object" && !Array.isArray(loaded)) {
      metadata = loaded as Record<string, unknown>;
    }
  }
  return { metadata, body };
}

/** Return a normalized copy of frontmatter metadata with lower-cased keys. */
export function normalizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}
