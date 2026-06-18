import React from 'react';
import { isColorLight } from '@/utils/color';
import './Pill.css';

export interface PillProps {
  text: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  onRightIconClick?: () => void;
  color?: string;
  className?: string;
  /** Visual variant. The link variants are used by inline node references. */
  variant?: 'default' | 'link' | 'link-page' | 'link-block' | 'link-class';
}

export const Pill: React.FC<PillProps> = ({
  text,
  leftIcon,
  rightIcon,
  onRightIconClick,
  color,
  className = '',
  variant = 'default',
}) => {
  const handleRightIconClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onRightIconClick?.();
  };

  const pillStyle = color
    // Intentionally hardcoded black/white: these are contrast-math results
    // against arbitrary user-chosen tag/property colors, not theme surfaces.
    ? { backgroundColor: color, color: isColorLight(color) ? '#000000' : '#ffffff' }
    : undefined;

  const variantClass = variant === 'default' ? '' : `pill--${variant}`;

  return (
    <div
      className={`pill ${variantClass} ${className}`}
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
