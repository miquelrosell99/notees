import { useState, useRef, useEffect, useCallback } from 'react';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '../hooks';
import './PropertyCell.css';

interface UrlPropertyCellProps {
  node: Node;
  property: Property;
  value: unknown;
  editable: boolean;
}

/**
 * UrlPropertyCell - Renders URL values as clickable links with inline editing
 */
export function UrlPropertyCell({
  node,
  property,
  value,
  editable,
}: UrlPropertyCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const setPropertyMutation = useSetNodeProperty();

  const urlValue = typeof value === 'string' ? value : '';

  const handleClick = useCallback(() => {
    if (!editable) return;
    setEditValue(urlValue);
    setIsEditing(true);
  }, [editable, urlValue]);

  const handleSave = useCallback(async () => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed === urlValue) return;
    try {
      await setPropertyMutation.mutateAsync({
        nodeId: node.id,
        propertyId: property.id,
        value: trimmed || null,
      });
    } catch (error) {
      console.error('Failed to save URL property:', error);
    }
  }, [editValue, urlValue, node.id, property.id, setPropertyMutation]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <div className="property-cell property-cell--editing">
        <input
          ref={inputRef}
          className="property-cell__input"
          type="url"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') { setIsEditing(false); setEditValue(''); }
          }}
          placeholder="https://..."
        />
      </div>
    );
  }

  if (!urlValue) {
    return (
      <button
        type="button"
        className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}
        onClick={handleClick}
      >
        <span className="property-placeholder">Empty</span>
      </button>
    );
  }

  if (!editable) {
    return (
      <a
        href={urlValue}
        target="_blank"
        rel="noopener noreferrer"
        className="property-cell property-cell--url property-cell__link"
      >
        {urlValue}
      </a>
    );
  }

  return (
    <button
      type="button"
      aria-label={urlValue}
      className="property-cell property-cell--url"
      onClick={handleClick}
    >
      <span className="property-cell__link">
        {urlValue}
      </span>
    </button>
  );
}
