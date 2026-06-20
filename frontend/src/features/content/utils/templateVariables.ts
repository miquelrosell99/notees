/**
 * Template variable helpers.
 *
 * Supports two placeholder styles:
 * - {{variable_name}}  -> user-provided static values
 * - <% dynamic_name %> -> computed at instantiation time (Logseq-style)
 */

export interface TemplateVariableContext {
  currentPageName?: string | null;
  currentPageUuid?: string | null;
  currentUserName?: string | null;
}

const DYNAMIC_VARIABLES = new Set([
  'today',
  'time',
  'datetime',
  'current_page',
  'current_page_uuid',
  'current_user',
]);

export function isDynamicVariable(name: string): boolean {
  return DYNAMIC_VARIABLES.has(name);
}

export function computeDynamicContext(
  names: string[],
  ctx: TemplateVariableContext,
): Record<string, string> {
  const now = new Date();
  const result: Record<string, string> = {};

  for (const name of names) {
    switch (name) {
      case 'today':
        result[name] = now.toISOString().slice(0, 10);
        break;
      case 'time':
        result[name] = now.toTimeString().slice(0, 5);
        break;
      case 'datetime':
        result[name] = now.toISOString();
        break;
      case 'current_page':
        result[name] = ctx.currentPageName || 'Untitled';
        break;
      case 'current_page_uuid':
        result[name] = ctx.currentPageUuid || '';
        break;
      case 'current_user':
        result[name] = ctx.currentUserName || '';
        break;
      default:
        // Unknown dynamic variables are left for the caller to handle.
        break;
    }
  }

  return result;
}
