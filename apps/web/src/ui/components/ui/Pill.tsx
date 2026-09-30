/**
 * Pill Component
 *
 * A small rounded label chip with optional left/right icons.
 * The right icon renders as a remove-style button when
 * `onRightIconClick` is provided.
 */

import type { FC, ReactNode, MouseEvent, KeyboardEvent } from 'react';
import './Pill.css';

/**
 * Determine if a color is light or dark based on perceived brightness.
 * Uses the YIQ formula so the text color keeps contrast on arbitrary
 * user-chosen tag/property colors.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleanHex = hex.replace('#', '');
  if (cleanHex.length === 3) {
    return {
      r: parseInt(cleanHex[0]! + cleanHex[0], 16),
      g: parseInt(cleanHex[1]! + cleanHex[1], 16),
      b: parseInt(cleanHex[2]! + cleanHex[2], 16),
    };
  }
  if (cleanHex.length === 6) {
    return {
      r: parseInt(cleanHex.slice(0, 2), 16),
      g: parseInt(cleanHex.slice(2, 4), 16),
      b: parseInt(cleanHex.slice(4, 6), 16),
    };
  }
  return null;
}

function isColorLight(color: string): boolean {
  const rgb = color.startsWith('#') ? hexToRgb(color) : null;
  if (!rgb) return true;
  const yiq = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
  return yiq >= 128;
}

export interface PillProps {
  text: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  onRightIconClick?: () => void;
  color?: string;
  className?: string;
  /** Visual variant. The link variants are used by inline node references. */
  variant?: 'default' | 'link' | 'link-page' | 'link-block' | 'link-class';
  /** When true, the right icon is hidden until the pill is hovered/focused and the pill expands to reveal it. */
  rightIconHoverReveal?: boolean;
}

export const Pill: FC<PillProps> = ({
  text,
  leftIcon,
  rightIcon,
  onRightIconClick,
  color,
  className = '',
  variant = 'default',
  rightIconHoverReveal = false,
}) => {
  const handleRightIconClick = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    onRightIconClick?.();
  };

  const pillStyle = color
    // Absolute black/white are contrast-math results against arbitrary
    // user-chosen tag/property colors, not theme surfaces.
    ? { backgroundColor: color, color: isColorLight(color) ? 'var(--color-black)' : 'var(--color-white)' }
    : undefined;

  const variantClass = variant === 'default' ? '' : `pill--${variant}`;
  const hoverRevealClass = rightIconHoverReveal ? 'pill--hover-reveal-right' : '';

  return (
    <div
      className={`pill ${variantClass} ${hoverRevealClass} ${className}`}
      style={pillStyle}
    >
      {leftIcon && (
        <span className="pill__left-icon">
          {leftIcon}
        </span>
      )}

      <span className="pill__text">
        {text}
      </span>

      {rightIcon && (
        <button
          type="button"
          className="pill__right-button"
          onClick={handleRightIconClick}
          aria-label="Remove"
        >
          {rightIcon}
        </button>
      )}
    </div>
  );
};
