/**
 * PropertyCreateModal Component
 * 
 * Floating modal for creating a new property with name and type.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiClose } from '@mdi/js';
import type { PropertyType } from '@/types/api';
import { Button } from '../core/Button';
import { BooleanToggle } from '../core/BooleanToggle';
import './PropertyCreateModal.css';

interface PropertyCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, type: PropertyType, isLocal: boolean) => void;
  initialName?: string;
}

const PROPERTY_TYPES: { type: PropertyType; label: string; icon: string; description: string }[] = [
  { type: 'text', label: 'Text', icon: '', description: 'Rich text content' },
  { type: 'integer', label: 'Number', icon: '', description: 'Whole numbers' },
  { type: 'float', label: 'Decimal', icon: '', description: 'Numbers with decimals' },
  { type: 'boolean', label: 'Checkbox', icon: '', description: 'True/false toggle' },
  { type: 'node', label: 'Relation', icon: '', description: 'Link to other pages' },
  { type: 'selection', label: 'Select', icon: '', description: 'Choose from options' },
  { type: 'date', label: 'Date', icon: '', description: 'Date value' },
];

export function PropertyCreateModal({
  isOpen,
  onClose,
  onCreate,
  initialName = '',
}: PropertyCreateModalProps) {
  const [name, setName] = useState(initialName);
  const [selectedType, setSelectedType] = useState<PropertyType>('text');
  const [isLocal, setIsLocal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setSelectedType('text');
      setIsLocal(false);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialName]);
  
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Property name is required');
      return;
    }
    
    onCreate(trimmedName, selectedType, isLocal);
  }, [name, selectedType, isLocal, onCreate]);
  
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
  
  if (!isOpen) return null;
  
  return (
    <div className="modal-backdrop property-create-backdrop" onClick={handleBackdropClick}>
      <div className="property-create-modal" onKeyDown={handleKeyDown}>
        <div className="property-create-header">
          <h3 className="property-create-title">Create Property</h3>
          <Button icon={mdiClose} iconOnly onClick={onClose} size="sm" variant="ghost" />
        </div>
        
        <form className="property-create-form" onSubmit={handleSubmit}>
          <div className="property-create-field">
            <label className="property-create-label" htmlFor="property-name">
              Name
            </label>
            <input
              ref={inputRef}
              id="property-name"
              type="text"
              className="property-create-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Property name"
            />
            {error && <span className="property-create-error">{error}</span>}
          </div>
          
          <div className="property-create-field">
            <label className="property-create-label">Type</label>
            <div className="property-type-grid">
              {PROPERTY_TYPES.map(({ type, label, icon, description }) => (
                <button
                  key={type}
                  type="button"
                  className={`property-type-option${selectedType === type ? ' selected' : ''}`}
                  onClick={() => setSelectedType(type)}
                >
                  <span className="property-type-icon">{icon}</span>
                  <span className="property-type-info">
                    <span className="property-type-label">{label}</span>
                    <span className="property-type-desc">{description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          
          <div className="property-create-field">
            <BooleanToggle
              label="Local"
              description={isLocal ? "Only for this node and typed nodes" : "Available for any node, unique name"}
              checked={isLocal}
              onChange={(e) => setIsLocal(e.target.checked)}
              labelPosition="left"
            />
          </div>
          
          <div className="property-create-actions">
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default PropertyCreateModal;
