/**
 * Class displayTemplate placeholder parsing + validation (pure functions).
 *
 * A class's displayTemplate is a literal string with `{{schemaName}}`
 * placeholders naming property schemas (citekey, authors, year, …). The
 * wire payload itself stays unvalidated — appliers map it without checking
 * (the parentlessRole precedent); these helpers fire at client write time
 * so an unknown or empty placeholder fails loud before it reaches the log.
 */

/** Loud failure for an invalid class displayTemplate (client write time). */
export class DisplayTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayTemplateError";
  }
}

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/**
 * Extracts the placeholder schema names from a template, in order of
 * appearance, each trimmed of surrounding whitespace. Templates without
 * placeholders yield []; an empty placeholder yields "" for its entry.
 */
export function parseDisplayTemplate(template: string): string[] {
  if (typeof template !== "string") {
    throw new DisplayTemplateError(
      `invalid display template: expected a string, got ${JSON.stringify(template)}`,
    );
  }
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    names.push((match[1] ?? "").trim());
  }
  return names;
}

/**
 * Validates a template against the property-schema names available on the
 * class: throws DisplayTemplateError listing unknown and empty
 * placeholders; passes silently when every placeholder resolves.
 */
export function validateDisplayTemplate(template: string, availableSchemaNames: Set<string>): void {
  const names = parseDisplayTemplate(template);
  const empty = names.filter((name) => name.length === 0);
  const unknown = names.filter((name) => name.length > 0 && !availableSchemaNames.has(name));
  if (empty.length === 0 && unknown.length === 0) return;
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(`unknown placeholder(s): ${[...new Set(unknown)].join(", ")}`);
  }
  if (empty.length > 0) {
    parts.push(`empty placeholder(s): ${empty.length}`);
  }
  throw new DisplayTemplateError(`invalid display template (${parts.join("; ")})`);
}
