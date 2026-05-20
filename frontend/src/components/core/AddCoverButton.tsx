/**
 * AddCoverButton Component
 * 
 * Reusable button for adding cover images to nodes.
 * Used in card views, table views, and anywhere a cover placeholder is needed.
 * Supports drag and drop of image files.
 */
import { useState } from 'react';

import { extractImageFromDragEvent } from '@/hooks/useDragDropImage';
import './AddCoverButton.css';
import { Icon } from '@/components/core/icons';

export interface AddCoverButtonProps {
  /** Callback when the button is clicked */
  onClick: () => void;
  /** Callback when a file is dropped (can be File object or URL string) */
  onDrop?: (file: File | string) => void;
  /** Optional CSS class */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

export function AddCoverButton({ 
  onClick, 
  onDrop,
  className = '', 
  size = 'md' 
}: AddCoverButtonProps) {
  const [isDragging, setIsDragging] = useState(false);
  
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    if (!onDrop) return;
    
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        onDrop(result.file);
      }
    } catch (error) {
      console.error('Failed to process dropped image:', error);
    }
  };
  
  return (
    <button 
      className={`add-cover-button add-cover-button--${size} ${isDragging ? 'add-cover-button--dragging' : ''} ${className}`}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      type="button"
      aria-label="Add cover image"
    >
      <Icon path={"mdi mdi-image-plus"} size={size === 'sm' ? 0.8 : size === 'lg' ? 1.2 : 1} />
      <span className="add-cover-button__text">
        {isDragging ? 'Drop image here' : 'Add cover'}
      </span>
    </button>
  );
}
