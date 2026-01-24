/**
 * NodeClassPill - A pill that displays a node class with icon and optional remove button
 * 
 * Used in:
 * - Block component (to the right of blocks)
 * - PageHeader (between title and properties)
 * 
 * Supports right-click to show a color picker for changing the node's color.
 */
import { useState, useCallback } from 'react';
import { Pill } from './core/Pill';
import { NodeIcon, CloseIcon } from './icons';
import { ColorPickerRow } from './nodes/NodeContextMenu';
import type { Node } from '@/types';
import './NodeClassPill.css';

interface NodeClassPillProps {
  /** The class node */
  classNode: Node;
  /** Callback when clicking the pill (usually to navigate to the class) */
  onClick?: () => void;
  /** Callback when clicking the remove button */
  onRemove?: () => void;
  /** Callback when changing the color via right-click menu */
  onColorChange?: (color: string | null) => void;
  /** Whether the pill is read-only (hides remove button and color change) */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function NodeClassPill({
  classNode,
  onClick,
  onRemove,
  onColorChange,
  readOnly = false,
  className = '',
}: NodeClassPillProps) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [colorPickerPos, setColorPickerPos] = useState({ x: 0, y: 0 });

  const handleRemove = () => {
    onRemove?.();
  };

  const handleClick = () => {
    onClick?.();
  };

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (readOnly || !onColorChange) return;
    e.preventDefault();
    e.stopPropagation();
    setColorPickerPos({ x: e.clientX, y: e.clientY });
    setShowColorPicker(true);
  }, [readOnly, onColorChange]);

  const handleColorChange = useCallback((color: string | null) => {
    onColorChange?.(color);
    setShowColorPicker(false);
  }, [onColorChange]);

  const handleColorPickerClose = useCallback(() => {
    setShowColorPicker(false);
  }, []);

  return (
    <>
      <div 
        className={`node-class-pill ${className}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`Click to view ${classNode.name}${onColorChange && !readOnly ? ' • Right-click to change color' : ''}`}
      >
        <Pill
          text={classNode.name}
          leftIcon={classNode.icon ? <NodeIcon icon={classNode.icon} isPage={true} size="xs" /> : undefined}
          rightIcon={!readOnly && onRemove ? <CloseIcon size="xs" /> : undefined}
          onRightIconClick={!readOnly ? handleRemove : undefined}
          color={classNode.color || undefined}
        />
      </div>
      
      {/* Color Picker Popup */}
      {showColorPicker && (
        <PillColorPicker
          position={colorPickerPos}
          currentColor={classNode.color ?? null}
          onColorChange={handleColorChange}
          onClose={handleColorPickerClose}
        />
      )}
    </>
  );
}

/**
 * Floating color picker popup for pills
 */
interface PillColorPickerProps {
  position: { x: number; y: number };
  currentColor: string | null;
  onColorChange: (color: string | null) => void;
  onClose: () => void;
}

function PillColorPicker({ position, currentColor, onColorChange, onClose }: PillColorPickerProps) {
  // Close on click outside
  const handleClickOutside = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  }, [onClose]);

  const handleContentClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div 
      className="pill-color-picker-overlay"
      onClick={handleClickOutside}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div 
        className="pill-color-picker"
        style={{ 
          position: 'fixed',
          left: position.x,
          top: position.y,
        }}
        onClick={handleContentClick}
      >
        <ColorPickerRow 
          currentColor={currentColor} 
          onColorChange={onColorChange} 
        />
      </div>
    </div>
  );
}
