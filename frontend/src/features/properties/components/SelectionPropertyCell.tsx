import { useState, useRef } from 'react';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '../hooks';
import { useClickOutside } from '@/hooks/useClickOutside';
import { Pill } from '@/components/ui/Pill';
import { Icon, NodeIcon } from '@/components/ui/icons';
import { parseIconField } from '@/utils/iconDom';
import { Button } from '@/components/ui/Button';

import './PropertyCell.css';

interface SelectionPropertyCellProps {
  property: Property;
  parentNode: Node;
  value: unknown;
  editable: boolean;
}

/**
 * SelectionPropertyCell - Handles selection-type properties with picker
 */
export function SelectionPropertyCell({
  property,
  parentNode,
  value,
  editable,
}: SelectionPropertyCellProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  const setPropertyMutation = useSetNodeProperty();
  const options = property.options ?? [];

  // Close picker on outside click
  useClickOutside(cellRef, () => {
    if (isPickerOpen) setIsPickerOpen(false);
  }, isPickerOpen);

  // Parse selected values
  const selectedValues = Array.isArray(value) ? value : value ? [value] : [];
  const resolvedOptions = selectedValues
    .map(v => {
      const optionId = typeof v === 'object' && v !== null && 'uuid' in v ? (v as { uuid: string }).uuid : v;
      return options.find(opt => opt.uuid === optionId);
    })
    .filter((opt): opt is NonNullable<typeof opt> => opt !== undefined);

  const handleAddOption = (option: typeof options[0]) => {
    if (property.multi) {
      const currentValue = Array.isArray(value) ? value : [];
      setPropertyMutation.mutate({
        nodeUuid: parentNode.uuid,
        propertyId: property.uuid,
        value: [...currentValue, option.uuid],
      });
    } else {
      setPropertyMutation.mutate({
        nodeUuid: parentNode.uuid,
        propertyId: property.uuid,
        value: option.uuid,
      });
    }
    setIsPickerOpen(false);
  };

  const handleRemoveOption = (option: typeof options[0]) => {
    if (property.multi && Array.isArray(value)) {
      setPropertyMutation.mutate({
        nodeUuid: parentNode.uuid,
        propertyId: property.uuid,
        value: value.filter(id => id !== option.uuid),
      });
    } else {
      setPropertyMutation.mutate({
        nodeUuid: parentNode.uuid,
        propertyId: property.uuid,
        value: null,
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!editable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsPickerOpen((prev) => !prev);
    }
  };

  // Empty state
  if (resolvedOptions.length === 0) {
    return (
      <div
        ref={cellRef}
        className={`property-cell property-cell--empty-wrapper ${editable ? 'property-cell--editable' : ''}`}
      >
        <button
          type="button"
          className="property-cell property-cell--empty"
          onClick={() => editable && setIsPickerOpen((prev) => !prev)}
          onKeyDown={handleKeyDown}
          title={editable ? 'Click to select' : undefined}
          disabled={!editable}
        >
          <span className="property-placeholder">Empty</span>
        </button>
        {isPickerOpen && (
          <div className="property-cell__picker">
            {options.map(option => {
              const color = option.color || parseIconField(option.icon || '').color || null;
              return (
                <button
                  type="button"
                  key={option.uuid}
                  className="property-cell__picker-option"
                  onClick={() => handleAddOption(option)}
                >
                  {color
                    ? <span className="selection-color-dot" style={{ background: color }} />
                    : option.icon && <NodeIcon icon={option.icon} size="xs" />}
                  <span>{option.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Has values
  return (
    <div ref={cellRef} className="property-cell property-cell--selection">
      {resolvedOptions.map((option) => {
        const color = option.color || parseIconField(option.icon || '').color || null;
        return (
          <Pill
            key={option.uuid}
            text={option.name}
            color={color || undefined}
            rightIcon={editable ? <Icon path={"mdi mdi-close"} size={0.55} /> : undefined}
            onRightIconClick={editable ? () => handleRemoveOption(option) : undefined}
          />
        );
      })}
      {editable && property.multi && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsPickerOpen((prev) => !prev)}
          className="property-cell__add-button"
        >
          +
        </Button>
      )}
      {isPickerOpen && (
        <div className="property-cell__picker">
          {options
            .filter(opt => !resolvedOptions.some(r => r.uuid === opt.uuid))
            .map(option => {
              const color = option.color || parseIconField(option.icon || '').color || null;
              return (
                <button
                  type="button"
                  key={option.uuid}
                  className="property-cell__picker-option"
                  onClick={() => handleAddOption(option)}
                >
                  {color
                    ? <span className="selection-color-dot" style={{ background: color }} />
                    : option.icon && <NodeIcon icon={option.icon} size="xs" />}
                  <span>{option.name}</span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
