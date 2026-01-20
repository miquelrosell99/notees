/**
 * PropertyEditModal Component
 * 
 * Floating modal for editing property name and icon.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import type { Property } from '@/types/api';
import { EmojiPickerTrigger } from './core/EmojiPicker';
import { ButtonClose } from './core/ButtonClose';
import { Button } from './core/Button';
import './PropertyEditModal.css';

interface PropertyEditModalProps {
  isOpen: boolean;
  property: Property | null;
  onClose: () => void;
  onSave: (propertyId: number, updates: { name?: string; icon?: string }) => void;
}

export function PropertyEditModal({
  isOpen,
  property,
  onClose,
  onSave,
}: PropertyEditModalProps) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Initialize form when property changes or modal opens
  useEffect(() => {
    if (isOpen && property) {
      setName(property.name);
      setIcon(property.icon || '');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, property]);
  
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    
    if (!property) return;
    
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Property name is required');
      return;
    }
    
    // Only include changed values
    const updates: { name?: string; icon?: string } = {};
    if (trimmedName !== property.name) {
      updates.name = trimmedName;
    }
    if (icon !== (property.icon || '')) {
      updates.icon = icon || undefined;
    }
    
    // Only save if something changed
    if (Object.keys(updates).length > 0) {
      onSave(property.id, updates);
    }
    onClose();
  }, [property, name, icon, onSave, onClose]);
  
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [onClose]);
  
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };
  
  if (!isOpen || !property) return null;
  
  return (
    <div className="modal-backdrop property-edit-backdrop" onClick={handleBackdropClick}>
      <div className="property-edit-modal" onKeyDown={handleKeyDown}>
        <div className="property-edit-header">
          <h3 className="property-edit-title">Edit Property</h3>
          <ButtonClose onClick={onClose} size="sm" />
        </div>
        
        <form className="property-edit-form" onSubmit={handleSubmit}>
          <div className="property-edit-field">
            <label className="property-edit-label" htmlFor="property-edit-name">
              Name
            </label>
            <input
              ref={inputRef}
              id="property-edit-name"
              type="text"
              className="property-edit-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Property name"
            />
            {error && <span className="property-edit-error">{error}</span>}
          </div>
          
          <div className="property-edit-field">
            <label className="property-edit-label">
              Icon (optional)
            </label>
            <div className="property-edit-icon-row">
              <EmojiPickerTrigger
                value={icon}
                onSelect={setIcon}
                placeholder="Add icon"
                className="property-edit-icon-trigger"
              />
              {icon && (
                <span className="property-edit-icon-preview">
                  Selected: {icon}
                </span>
              )}
            </div>
          </div>
          
          <div className="property-edit-info">
            <span className="property-edit-type">
              Type: <strong>{property.type}</strong>
            </span>
            {property.is_system && (
              <span className="property-edit-system-badge">System Property</span>
            )}
          </div>
          
          <div className="property-edit-actions">
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default PropertyEditModal;
