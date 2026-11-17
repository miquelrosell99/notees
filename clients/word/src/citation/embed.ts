export interface CitationEmbed {
  citationId: string;
  nodeIds: string[];
  styleId: string;
  locator?: string;
}

export interface BibliographyEmbed {
  styleId: string;
}

export const CITATION_FIELD_PREFIX = "ADDIN notees.Citation ";
export const BIBLIOGRAPHY_FIELD_PREFIX = "ADDIN notees.Bibliography ";

export function buildCitationCode(embed: CitationEmbed): string {
  return CITATION_FIELD_PREFIX + JSON.stringify(embed);
}

export function parseCitationCode(code: string): CitationEmbed | null {
  if (!code.startsWith(CITATION_FIELD_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(code.slice(CITATION_FIELD_PREFIX.length).trimEnd());
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.citationId !== "string") return null;
  if (!Array.isArray(obj.nodeIds) || obj.nodeIds.length === 0) return null;
  if (!obj.nodeIds.every((id) => typeof id === "string")) return null;
  if (typeof obj.styleId !== "string") return null;
  if (obj.locator !== undefined && typeof obj.locator !== "string") return null;
  return raw as CitationEmbed;
}

export function buildBibliographyCode(embed: BibliographyEmbed): string {
  return BIBLIOGRAPHY_FIELD_PREFIX + JSON.stringify(embed);
}

export function parseBibliographyCode(code: string): BibliographyEmbed | null {
  if (!code.startsWith(BIBLIOGRAPHY_FIELD_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(code.slice(BIBLIOGRAPHY_FIELD_PREFIX.length).trimEnd());
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.styleId !== "string") return null;
  return raw as BibliographyEmbed;
}

export function isNoteesCitation(code: string): boolean {
  return code.startsWith(CITATION_FIELD_PREFIX);
}

/**
 * Clone an embed with a different styleId, preserving citationId, nodeIds,
 * locator and any forward-compatible extra keys. This is the ONLY way a
 * style switch may reach an already-inserted citation: new citations take the
 * picker's style at insert time; existing fields change only when the user
 * explicitly restyles them (Review-Focus #3).
 */
export function withStyle(embed: CitationEmbed, styleId: string): CitationEmbed {
  return { ...embed, styleId };
}
