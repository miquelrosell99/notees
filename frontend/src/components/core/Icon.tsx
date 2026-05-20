/**
 * Icon — renders MDI icons via @mdi/font CSS classes.
 *
 * Renders MDI icons via the @mdi/font CSS webfont instead of inline SVG.
 * Accepts the same props so callers don't need to change their JSX.
 */
import React from 'react';

export interface IconProps {
  /** MDI CSS class string, e.g. "mdi mdi-heart-outline" */
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
  const style: React.CSSProperties = {};

  if (typeof size === 'number') {
    style.fontSize = `${size * 24}px`;
  } else if (typeof size === 'string') {
    style.fontSize = size;
  }

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

  const mdiClass = path.startsWith('mdi ') ? path : `mdi ${path}`;
  const classes = [mdiClass, className].filter(Boolean).join(' ');

  return <i className={classes} style={style} title={title} />;
};
