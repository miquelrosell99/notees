/**
 * NodeIcon — renders an icon from a node's stored icon field.
 *
 * Supports:
 * - Emoji characters (rendered as-is)
 * - MDI icon names in camelCase (e.g. "mdiCalendarToday") or kebab-case
 * - Falls back to type-based defaults (page → document, block → bullet)
 */

import { Icon } from "../../Icon.js";
import { cssColorFor } from "../ui/colorPresets.js";

export type NodeIconSize = "xs" | "sm" | "md" | "lg" | "xl" | number;

const SIZES: Record<Exclude<NodeIconSize, number>, number> = {
  xs: 0.6,
  sm: 0.7,
  md: 0.85,
  lg: 1,
  xl: 1.4,
};

function resolveSize(size: NodeIconSize): number {
  return typeof size === "number" ? size : (SIZES[size] ?? 0.85);
}

export function NodeIcon({
  icon: rawIcon,
  isPage = true,
  size = "sm",
  className,
  color: colorProp,
}: {
  icon?: string | null;
  isPage?: boolean;
  size?: NodeIconSize;
  className?: string;
  color?: string | null;
}) {
  // Parse JSON-encoded icon fields like {"icon":"mdiCalendarToday","color":"green"}
  // (the color rides the token|hex grammar).
  let icon = rawIcon;
  let parsedColor: string | undefined;
  if (rawIcon) {
    try {
      const parsed = JSON.parse(rawIcon) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).icon === "string"
      ) {
        const obj = parsed as { icon: string; color?: string };
        icon = obj.icon;
        parsedColor = obj.color || undefined;
      }
    } catch {
      // Not JSON — use as plain string
    }
  }
  // Explicit color prop overrides parsed color. Both carry stored colors
  // (tokens/hex) — bridge to CSS at this render boundary.
  const color = colorProp ?? parsedColor;
  const resolvedSize = resolveSize(size);
  const colorPropForIcon = color !== undefined && color !== null ? cssColorFor(color) : undefined;

  // If icon is provided, resolve it as an MDI path (camelCase or kebab-case).
  if (icon) {
    return (
      <Icon
        path={icon.startsWith("mdi") ? icon : `mdi-${icon}`}
        size={resolvedSize}
        {...(className !== undefined ? { className } : {})}
        {...(colorPropForIcon !== undefined ? { color: colorPropForIcon } : {})}
      />
    );
  }

  // Fall back to type-based defaults
  if (isPage) {
    return (
      <Icon
        path="mdi-file-document-outline"
        size={resolvedSize}
        {...(className !== undefined ? { className } : {})}
        {...(colorPropForIcon !== undefined ? { color: colorPropForIcon } : {})}
      />
    );
  }
  return (
    <Icon
      path="mdi-circle-small"
      size={resolvedSize}
      {...(className !== undefined ? { className } : {})}
      {...(colorPropForIcon !== undefined ? { color: colorPropForIcon } : {})}
    />
  );
}
