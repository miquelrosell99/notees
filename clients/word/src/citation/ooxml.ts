import {
  buildBibliographyCode,
  buildCitationCode,
  parseBibliographyCode,
  parseCitationCode,
  type BibliographyEmbed,
  type CitationEmbed,
} from "./embed";

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (m, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (entity.startsWith("#x")) {
          const cp = Number.parseInt(entity.slice(2), 16);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        if (entity.startsWith("#")) {
          const cp = Number.parseInt(entity.slice(1), 10);
          return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return m;
    }
  });
}

export function citationFieldXml(embed: CitationEmbed, displayText: string): string {
  const instr = ` ${buildCitationCode(embed)} `;
  return `<w:fldSimple w:instr="${escapeXml(instr)}"><w:r><w:t xml:space="preserve">${escapeXml(displayText)}</w:t></w:r></w:fldSimple>`;
}

export function bibliographyFieldXml(embed: BibliographyEmbed, displayText: string): string {
  const instr = ` ${buildBibliographyCode(embed)} `;
  return `<w:fldSimple w:instr="${escapeXml(instr)}"><w:r><w:t xml:space="preserve">${escapeXml(displayText)}</w:t></w:r></w:fldSimple>`;
}

export interface ScannedField {
  code: string;
  displayText: string;
  kind: "citation" | "bibliography" | "foreign";
  embed: CitationEmbed | BibliographyEmbed | null;
}

/** Classify a raw field instruction code. Exported for the refresh seam. */
export function classify(code: string): Pick<ScannedField, "kind" | "embed"> {
  const citation = parseCitationCode(code);
  if (citation) return { kind: "citation", embed: citation };
  const bibliography = parseBibliographyCode(code);
  if (bibliography) return { kind: "bibliography", embed: bibliography };
  return { kind: "foreign", embed: null };
}

interface ComplexFrame {
  code: string;
  display: string;
  inResult: boolean;
}

interface SimpleFrame {
  code: string;
  display: string;
}

// Tokens that matter for field scanning, matched in document order. Tag-only
// alternatives come before the text-bearing ones so a `<w:t …>` open tag is
// never mistaken for a self-closing token.
const TOKEN =
  /<w:fldSimple\b[^>]*\/>|<w:fldSimple\b[^>]*>|<\/w:fldSimple>|<w:fldChar\b[^>]*\/>|<w:fldChar\b[^>]*>|<w:instrText\b[^>]*\/>|<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>|<w:t\b[^>]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

function fldCharType(tag: string): string | null {
  const m = tag.match(/\bw:fldCharType\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

function instrAttribute(tag: string): string | null {
  const m = tag.match(/\bw:instr\s*=\s*"([^"]*)"/);
  return m ? m[1] : null;
}

/**
 * Best-effort scan of a `body.getOoxml()`-style dump. Handles both
 * `<w:fldSimple w:instr="…">` fields and complex fields built from
 * `<w:fldChar>` begin/separate/end runs with `<w:instrText>` instruction
 * content. Never throws: malformed or unterminated fields are skipped.
 */
export function scanDocumentXml(documentXml: string): ScannedField[] {
  const fields: ScannedField[] = [];
  if (typeof documentXml !== "string" || documentXml.length === 0) return fields;

  try {
    const complex: ComplexFrame[] = [];
    let simple: SimpleFrame | null = null;

    const pushField = (code: string, displayText: string) => {
      const trimmed = code.trim();
      fields.push({ code: trimmed, displayText, ...classify(trimmed) });
    };

    for (const m of documentXml.matchAll(TOKEN)) {
      const token = m[0];
      if (token.startsWith("<w:fldSimple")) {
        const selfClosing = token.endsWith("/>");
        const instr = instrAttribute(token);
        if (instr !== null) {
          const code = unescapeXml(instr).trim();
          if (selfClosing) {
            pushField(code, "");
          } else {
            simple = { code, display: "" };
          }
        } else {
          simple = null;
        }
        continue;
      }
      if (token.startsWith("</w:fldSimple>")) {
        if (simple) {
          pushField(simple.code, simple.display);
          simple = null;
        }
        continue;
      }
      if (token.startsWith("<w:fldChar")) {
        const type = fldCharType(token);
        if (type === "begin") {
          complex.push({ code: "", display: "", inResult: false });
        } else if (type === "separate") {
          const top = complex[complex.length - 1];
          if (top) top.inResult = true;
        } else if (type === "end") {
          const frame = complex.pop();
          if (frame) pushField(frame.code, frame.display);
        }
        continue;
      }
      if (token.startsWith("<w:instrText")) {
        const top = complex[complex.length - 1];
        if (top && m[1] !== undefined) top.code += unescapeXml(m[1]);
        continue;
      }
      if (token.startsWith("<w:t")) {
        const text = m[2] !== undefined ? unescapeXml(m[2]) : "";
        if (simple) simple.display += text;
        else {
          const top = complex[complex.length - 1];
          if (top && top.inResult) top.display += text;
        }
        continue;
      }
    }
    // Unterminated complex fields and unclosed fldSimple elements are dropped.
  } catch {
    // Best-effort contract: return whatever was collected before the failure.
  }
  return fields;
}
