import React from 'react';
import { isColorLight } from '@/utils/color';
import './Pill.css';

interface PillProps {
  text: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  onRightIconClick?: () => void;
  color?: string;
  className?: string;
}

export const Pill: React.FC<PillProps> = ({
  text,
  leftIcon,
  rightIcon,
  onRightIconClick,
  color,
  className = '',
}) => {
  const handleRightIconClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRightIconClick?.();
  };

  const pillStyle = color
    // Intentionally hardcoded black/white: these are contrast-math results
    // against arbitrary user-chosen tag/property colors, not theme surfaces.
    ? { backgroundColor: color, color: isColorLight(color) ? '#000000' : '#ffffff' }
    : undefined;

  return (
    <div 
      className={`pill ${className}`}
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
          className="pill__right-button"
          onClick={handleRightIconClick}
          type="button"
          aria-label="Remove"
        >
          {rightIcon}
        </button>
      )}
    </div>
  );
};
