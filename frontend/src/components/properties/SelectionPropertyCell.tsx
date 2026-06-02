import { useState, useRef } from 'react';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '@/hooks';
import { useClickOutside } from '@/hooks/useClickOutside';
import { Pill } from '@/components/core/Pill';
import { Icon, NodeIcon } from '@/components/core/icons';
import { parseIconField } from '@/utils/iconDom';
import { Button } from '@/components/core/Button';

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
      const optionId = typeof v === 'object' && v !== null && 'id' in v ? (v as { id: number }).id : v;
      return options.find(opt => opt.id === optionId);
    })
    .filter((opt): opt is NonNullable<typeof opt> => opt !== undefined);

  const handleAddOption = (option: typeof options[0]) => {
    if (property.multi) {
      const currentValue = Array.isArray(value) ? value : [];
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: [...currentValue, option.id],
      });
    } else {
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: option.id,
      });
    }
    setIsPickerOpen(false);
  };

  const handleRemoveOption = (option: typeof options[0]) => {
    if (property.multi && Array.isArray(value)) {
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: value.filter(id => id !== option.id),
      });
    } else {
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: null,
      });
    }
  };

  // Empty state
  if (resolvedOptions.length === 0) {
    return (
      <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
        ref={cellRef}
        className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}
        onClick={() => editable && setIsPickerOpen(true)}
        title={editable ? 'Click to select' : undefined}
      >
        <span className="property-placeholder">Empty</span>
        {isPickerOpen && (
          <div className="property-cell__picker">
            {options.map(option => {
              const color = option.color || parseIconField(option.icon || '').color || null;
              return (
                <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                  key={option.id}
                  className="property-cell__picker-option"
                  onClick={() => handleAddOption(option)}
                >
                  {color
                    ? <span className="selection-color-dot" style={{ background: color }} />
                    : option.icon && <NodeIcon icon={option.icon} size="xs" />}
                  <span>{option.name}</span>
                </div>
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
            key={option.id}
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
          onClick={() => setIsPickerOpen(true)}
          className="property-cell__add-button"
        >
          +
        </Button>
      )}
      {isPickerOpen && (
        <div className="property-cell__picker">
          {options
            .filter(opt => !resolvedOptions.some(r => r.id === opt.id))
            .map(option => {
              const color = option.color || parseIconField(option.icon || '').color || null;
              return (
                <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
                  key={option.id}
                  className="property-cell__picker-option"
                  onClick={() => handleAddOption(option)}
                >
                  {color
                    ? <span className="selection-color-dot" style={{ background: color }} />
                    : option.icon && <NodeIcon icon={option.icon} size="xs" />}
                  <span>{option.name}</span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
