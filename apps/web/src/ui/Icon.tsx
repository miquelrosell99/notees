/**
 * Icon — renders MDI icons as inline SVGs via a shared sprite sheet, or a
 * text glyph (emoji icons) when the stored value is not an MDI name. The
 * resolver is the iconDom contract: mdi-prefixed camelCase ("mdiHeart"),
 * "mdi-heart-outline", bare "heart-outline", JSON-wrapped {"icon": …}
 * (legacy rows), and anything else renders as text (emoji passthrough).
 */
import React from 'react';
import { resolveIconSize } from './iconSizes.js';

export interface IconProps {
  /** MDI CSS class string, e.g. "mdi mdi-heart-outline" or "mdi-heart-outline" */
  path: string;
  /** Size multiplier (1 = 24px), named token (e.g. "sm"), or explicit CSS string */
  size?: number | string;
  /** CSS color */
  color?: string;
  /** Additional CSS classes */
  className?: string;
  /** HTML title attribute */
  title?: string;
  /** Rotation in degrees */
  rotate?: number;
  /** Flip horizontally */
  horizontal?: boolean;
  /** Flip vertically */
  vertical?: boolean;
}

function camelToKebab(name: string): string {
  const rest = name.slice(3);
  let result = rest[0]?.toLowerCase() ?? '';
  for (const char of rest.slice(1)) {
    result += char === char.toUpperCase() ? '-' + char.toLowerCase() : char;
  }
  return result;
}

type ResolvedIcon = { kind: "mdi"; name: string } | { kind: "text"; glyph: string } | null;

function resolveIcon(path: string): ResolvedIcon {
  let value = path.trim();
  if (value === "") return null;

  // JSON-encoded icon field (legacy rows): {"icon":"mdiHeart", …}.
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) {
      const inner = (parsed as Record<string, unknown>).icon;
      if (typeof inner === "string") value = inner.trim();
    }
  } catch {
    // not JSON — the common case
  }

  const stripped = value.replace(/^mdi\s+/, "").replace(/^mdi-/, "");
  const wasMdiPrefixed = stripped !== value;
  if (wasMdiPrefixed && /^[a-z0-9-]+$/.test(stripped)) {
    return { kind: "mdi", name: stripped };
  }
  if (/^mdi[A-Z]/.test(value)) {
    return { kind: "mdi", name: camelToKebab(value) };
  }
  // Emoji / text glyph passthrough (the original contract).
  return { kind: "text", glyph: value };
}

export const Icon: React.FC<IconProps> = ({
  path,
  size = 1,
  color,
  className,
  title,
  rotate,
  horizontal,
  vertical,
}) => {
  const resolved = resolveIcon(path);

  const style: React.CSSProperties = { verticalAlign: 'middle' };

  const resolvedSize = resolveIconSize(size ?? 1);
  const width = typeof resolvedSize === 'number' ? `${resolvedSize * 24}px` : resolvedSize;
  const height = width;

  if (color) {
    style.color = color;
  }

  const transforms: string[] = [];
  if (rotate) transforms.push(`rotate(${rotate}deg)`);
  if (horizontal) transforms.push('scaleX(-1)');
  if (vertical) transforms.push('scaleY(-1)');
  if (transforms.length) {
    style.transform = transforms.join(' ');
  }

  if (resolved === null) {
    return null;
  }
  if (resolved.kind === "text") {
    return (
      <span
        className={className}
        style={{ ...style, fontSize: width, lineHeight: 1 }}
        aria-hidden={!title}
        role={title ? 'img' : undefined}
        aria-label={title || undefined}
      >
        {resolved.glyph}
      </span>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      width={width}
      height={height}
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden={!title}
      role={title ? 'img' : undefined}
      aria-label={title || undefined}
    >
      {title && <title>{title}</title>}
      <use href={`/mdi-sprite.svg#mdi-${resolved.name}`} />
    </svg>
  );
};
