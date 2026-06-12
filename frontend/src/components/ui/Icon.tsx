/**
 * Icon — renders MDI icons as inline SVGs via a shared sprite sheet.
 *
 * All 7,000+ Material Design Icons are available through a single cached
 * static asset (`/mdi-sprite.svg`) referenced with `<use>`.
 */
import React from 'react';

export interface IconProps {
  /** MDI CSS class string, e.g. "mdi mdi-heart-outline" or "mdi-heart-outline" */
  path: string;
  /** Size multiplier (1 = 24px) or explicit CSS string */
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

function resolveMdiName(path: string): string | null {
  const normalized = path.replace(/^mdi\s+/, '').replace(/^mdi-/, '');

  // Already kebab-case (e.g. "heart-outline")
  if (!normalized.startsWith('mdi')) {
    return normalized;
  }

  // camelCase (e.g. "mdiCalendarToday")
  if (normalized.match(/^mdi[A-Z]/)) {
    return camelToKebab(normalized);
  }

  return null;
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
  const name = resolveMdiName(path);

  if (!name) {
    return null;
  }

  const style: React.CSSProperties = { verticalAlign: 'middle' };

  const width = typeof size === 'number' ? `${size * 24}px` : size;
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
      <use href={`/mdi-sprite.svg#mdi-${name}`} />
    </svg>
  );
};
