/**
 * Citekey pattern workspace setting helpers.
 *
 * The backend interprets the pattern (app/domain/services/citekey.py); the
 * frontend only stores/displays it. Tokens: {family_name},
 * {organization_name}, {year}, {title_word} with :lower/:upper modifiers.
 */
export const CITEKEY_PATTERN_SETTING_KEY = 'citekey_pattern';
export const DEFAULT_CITEKEY_PATTERN = '{family_name:lower}{year}';

/**
 * Resolve the effective citekey pattern from workspace settings, falling back
 * to the default when unset or blank.
 */
export function getCitekeyPattern(settings: Record<string, unknown> | undefined): string {
  const value = settings?.[CITEKEY_PATTERN_SETTING_KEY];
  return typeof value === 'string' && value.trim() ? value : DEFAULT_CITEKEY_PATTERN;
}

/**
 * Validate a pattern draft before persisting. Returns an error message or null.
 */
export function validateCitekeyPattern(pattern: string): string | null {
  if (!pattern.trim()) {
    return 'Pattern must not be empty';
  }
  const tokenRe = /\{([A-Za-z_]+)(?::(lower|upper))?\}/g;
  const knownTokens = new Set(['family_name', 'organization_name', 'year', 'title_word']);
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(pattern)) !== null) {
    if (!knownTokens.has(match[1])) {
      return `Unknown token "{${match[1]}}". Supported: family_name, organization_name, year, title_word`;
    }
  }
  return null;
}
