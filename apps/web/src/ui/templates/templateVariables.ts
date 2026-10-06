/**
 * Template apply-time variables — the UI-side half of the
 * variable system. The clone engine (core/clone.ts) owns the syntax
 * (`{{name}}` spans inside text tokens), the subtree-wide extraction, and
 * the substitution at composition; this module classifies the names and
 * computes the dynamic values the variable dialog displays readonly.
 *
 * One syntax for both kinds: `{{name}}`.
 * - Static names — anything not in DYNAMIC_TEMPLATE_VARIABLES — are
 *   user-filled in the TemplateVariableDialog at apply time.
 * - Dynamic names are computed at apply time and shown readonly:
 *     today        local date YYYY-MM-DD (the UTC bug stays fixed —
 *                  toISOString is UTC)
 *     time         local HH:MM
 *     datetime     local ISO 8601 with offset
 *     current_page the view root's display name (empty when unnamed)
 */

/** Names computed at apply time (readonly in the dialog). */
export const DYNAMIC_TEMPLATE_VARIABLES: ReadonlySet<string> = new Set([
  "today",
  "time",
  "datetime",
  "current_page",
]);

export function isDynamicTemplateVariable(name: string): boolean {
  return DYNAMIC_TEMPLATE_VARIABLES.has(name);
}

/** Local YYYY-MM-DD (never UTC — the `toISOString().slice(0, 10)` bug). */
function localDateIso(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Local HH:MM. */
function localTimeHm(now: Date): string {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Local ISO 8601 with offset (no toISOString — that one is UTC by design). */
function localDateTimeIso(now: Date): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${localDateIso(now)}T${localTimeHm(now)}:00${sign}${oh}:${om}`;
}

export interface DynamicVariableContext {
  /** The view root's display name — the current_page value ("" when unnamed). */
  currentPageName?: string | undefined;
}

/**
 * Compute the dynamic subset of `names` at apply time. Unknown names are
 * skipped (the caller treats them as static — the dialog would have shown
 * them as editable rows).
 */
export function computeDynamicTemplateVariables(
  names: readonly string[],
  context: DynamicVariableContext = {},
  now: Date = new Date(),
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    switch (name) {
      case "today":
        values[name] = localDateIso(now);
        break;
      case "time":
        values[name] = localTimeHm(now);
        break;
      case "datetime":
        values[name] = localDateTimeIso(now);
        break;
      case "current_page":
        values[name] = context.currentPageName ?? "";
        break;
      default:
        break;
    }
  }
  return values;
}
