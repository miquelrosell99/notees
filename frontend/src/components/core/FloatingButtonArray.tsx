/**
 * FloatingButtonArray Component
 * 
 * Displays a collection of buttons inside a Card with consistent spacing.
 * Designed for floating action buttons on images and assets.
 */
import { type ReactNode } from 'react';
import { Card } from './Card';
import './FloatingButtonArray.css';

export interface FloatingButtonArrayProps {
  /** Button elements to display */
  children: ReactNode;
  /** Custom class name */
  className?: string;
  /** Direction of button layout */
  direction?: 'horizontal' | 'vertical';
  /** Size variant affecting spacing */
  size?: 'sm' | 'md';
}

/**
 * FloatingButtonArray - Displays buttons in a Card with consistent spacing
 */
export function FloatingButtonArray({
  children,
  className = '',
  direction = 'horizontal',
  size = 'md',
}: FloatingButtonArrayProps) {
  return (
    <Card 
      className={`floating-button-array floating-button-array--${direction} floating-button-array--${size} ${className}`}
      elevation="medium"
      variant="filled"
      padding={false}
      radius="sm"
    >
      <div className="floating-button-array__inner">
        {children}
      </div>
    </Card>
  );
}
