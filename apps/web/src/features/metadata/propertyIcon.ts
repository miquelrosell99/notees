/**
 * effectivePropertyIcon — the icon a property row's header renders, a PURE
 * READ-TIME derivation (nothing stored): the schema's own icon when set,
 * otherwise a fallback by property TYPE. The fallback keeps the panel
 * scannable — every property header carries an icon even when the schema
 * never got one (the common case for imported/CLI-authored schemas).
 *
 * The fallback names must exist in public/mdi-sprite.svg (checked at
 * authoring time — the sprite is the drawn authority).
 */

/** The type → icon table (mdi names, sprite-verified). */
const TYPE_ICONS: Record<string, string> = {
  text: "mdi-format-text",
  email: "mdi-email-outline",
  image: "mdi-image-outline",
  number: "mdi-numeric",
  select: "mdi-format-list-checks",
  multi_select: "mdi-format-list-checkbox",
  boolean: "mdi-check-circle-outline",
  datetime: "mdi-calendar-clock",
  object: "mdi-target",
  asset: "mdi-paperclip",
};

/** Schema-less rows (the schema was deleted) and unknown types. */
const FALLBACK_ICON = "mdi-tag-outline";

/**
 * The effective icon for a property header. `schema` is the narrow effective
 * schema projection (icon/type may both be absent); a null schema (deleted)
 * yields the generic fallback.
 */
export function effectivePropertyIcon(schema: { icon?: string | null; type?: string } | null): string {
  const stored = schema?.icon;
  if (typeof stored === "string" && stored.trim() !== "") return stored;
  const type = schema?.type;
  if (type !== undefined && TYPE_ICONS[type] !== undefined) return TYPE_ICONS[type];
  return FALLBACK_ICON;
}
