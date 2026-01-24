import React from 'react';
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

  return (
    <div 
      className={`pill ${className}`}
      style={color ? { backgroundColor: color } : undefined}
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
