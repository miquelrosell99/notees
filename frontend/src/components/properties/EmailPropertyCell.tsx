import { useState, useRef, useEffect, useCallback } from 'react';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '@/hooks';
import './PropertyCell.css';

interface EmailPropertyCellProps {
  node: Node;
  property: Property;
  value: unknown;
  editable: boolean;
}

/**
 * EmailPropertyCell - Renders email values as mailto links with inline editing
 */
export function EmailPropertyCell({
  node,
  property,
  value,
  editable,
}: EmailPropertyCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const setPropertyMutation = useSetNodeProperty();

  const emailValue = typeof value === 'string' ? value : '';

  const handleClick = useCallback(() => {
    if (!editable) return;
    setEditValue(emailValue);
    setIsEditing(true);
  }, [editable, emailValue]);

  const handleSave = useCallback(async () => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed === emailValue) return;
    try {
      await setPropertyMutation.mutateAsync({
        nodeId: node.id,
        propertyId: property.id,
        value: trimmed || null,
      });
    } catch (error) {
      console.error('Failed to save email property:', error);
    }
  }, [editValue, emailValue, node.id, property.id, setPropertyMutation]);

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
          type="email"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') { setIsEditing(false); setEditValue(''); }
          }}
          placeholder="name@example.com"
        />
      </div>
    );
  }

  if (!emailValue) {
    return (
      <div
        className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}
        onClick={handleClick}
      >
        <span className="property-placeholder">Empty</span>
      </div>
    );
  }

  return (
    <div className="property-cell property-cell--email" onClick={editable ? handleClick : undefined}>
      <a
        href={`mailto:${emailValue}`}
        className="property-cell__link"
        onClick={(e) => { if (editable) e.preventDefault(); }}
      >
        {emailValue}
      </a>
    </div>
  );
}
