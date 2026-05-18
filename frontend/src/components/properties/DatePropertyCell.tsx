import { useState, useRef, useMemo, useCallback } from 'react';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty, useNode } from '@/hooks';
import { getOrCreateDaily } from '@/api/nodes';
import { DatePickerPopup } from '@/components/core/DatePickerPopup';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import './PropertyCell.css';

interface DatePropertyCellProps {
  node: Node;
  property: Property;
  value: unknown;
  editable: boolean;
}

/**
 * DatePropertyCell - Renders date values with DatePickerPopup for editing
 * Date properties store a day-page node ID; we resolve it to show the name
 */
export function DatePropertyCell({
  node,
  property,
  value,
  editable,
}: DatePropertyCellProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  const setPropertyMutation = useSetNodeProperty();

  // value is a day-page node ID (number)
  const dayNodeId = typeof value === 'number' ? value : null;
  const { data: dayNode } = useNode(dayNodeId);

  // Derive ISO date from the day node's UUID (format: YYYYMMDD)
  const isoDate = useMemo(() => {
    if (!dayNode?.uuid) return undefined;
    const u = dayNode.uuid;
    if (u.length === 8 && /^\d{8}$/.test(u)) {
      return `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    }
    return undefined;
  }, [dayNode?.uuid]);

  const displayName = dayNode ? nodeNameToText(dayNode.name) : '';

  const handleSelect = useCallback(async (selectedIsoDate: string) => {
    setIsPickerOpen(false);
    try {
      const dayPage = await getOrCreateDaily(selectedIsoDate);
      await setPropertyMutation.mutateAsync({
        nodeId: node.id,
        propertyId: property.id,
        value: dayPage.id,
      });
    } catch (error) {
      console.error('Failed to save date property:', error);
    }
  }, [node.id, property.id, setPropertyMutation]);

  if (!dayNodeId) {
    return (
      <div
        ref={cellRef}
        className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}
        onClick={async (e) => {
          if (!editable) return;
          if (e.shiftKey) {
            const today = new Date();
            const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            await handleSelect(isoToday);
            return;
          }
          setIsPickerOpen(true);
        }}
      >
        <span className="property-placeholder">Empty</span>
        {isPickerOpen && (
          <DatePickerPopup
            value={undefined}
            onSelect={handleSelect}
            onClose={() => setIsPickerOpen(false)}
            anchorRef={cellRef}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={cellRef}
      className={`property-cell property-cell--date ${editable ? 'property-cell--editable' : ''}`}
      onClick={() => editable && setIsPickerOpen(true)}
      title={editable ? 'Click to change date' : undefined}
    >
      <span className="property-cell__date-name">{displayName || '...'}</span>
      {isPickerOpen && (
        <DatePickerPopup
          value={isoDate}
          onSelect={handleSelect}
          onClose={() => setIsPickerOpen(false)}
          anchorRef={cellRef}
        />
      )}
    </div>
  );
}
