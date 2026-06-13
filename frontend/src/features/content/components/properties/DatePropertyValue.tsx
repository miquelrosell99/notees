import { useState, useCallback, useMemo, useRef } from 'react';
import { useNode } from '@/hooks';
import { DatePickerPopup } from '@/features/content/components/DatePickerPopup';
import { Button } from '@/components/ui/Button';
import { getOrCreateDaily } from '@/api/nodes';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import './DatePropertyValue.css';

interface DatePropertyValueProps {
  value: number | null;
  readOnly: boolean;
  onChange: (value: unknown) => void;
  onDelete?: () => void;
}

/**
 * Date property value component.
 * Shows the day page name; click opens a hidden date picker to select a new date.
 * The selected date creates/gets the day page and stores its ID as the relation value.
 */
export function DatePropertyValue({
  value,
  readOnly,
  onChange,
  onDelete,
}: DatePropertyValueProps) {
  const { data: dayNode } = useNode(value);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Convert day page UUID (YYYYMMDD) to YYYY-MM-DD for the DatePickerPopup
  const isoValue = useMemo(() => {
    if (!dayNode?.uuid) return '';
    const u = dayNode.uuid;
    if (u.length === 8 && /^\d{8}$/.test(u)) {
      return `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    }
    return '';
  }, [dayNode?.uuid]);

  const handleSelect = useCallback(async (isoDate: string) => {
    if (!isoDate) {
      onDelete?.();
      return;
    }
    setLoading(true);
    try {
      const newDayNode = await getOrCreateDaily(isoDate);
      onChange(newDayNode.id);
    } catch (err) {
      console.error('Failed to create/get day page:', err);
    } finally {
      setLoading(false);
    }
  }, [onChange, onDelete]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    if (readOnly || loading) return;
    if (e.shiftKey && value == null) {
      const today = new Date();
      const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      await handleSelect(isoToday);
      return;
    }
    setIsOpen((prev) => !prev);
  }, [readOnly, loading, value, handleSelect]);

  const displayName = dayNode ? nodeNameToText(dayNode.name) : null;

  return (
    <div className="property-value-date-container">
      <button
        ref={anchorRef}
        type="button"
        className="property-value-date-display"
        onClick={handleClick}
        disabled={readOnly || loading}
        title={readOnly ? undefined : 'Click to change date'}
      >
        {loading ? (
          <span className="property-placeholder">Setting…</span>
        ) : displayName ? (
          <span className="property-value-date-name">{displayName}</span>
        ) : (
          <span className="property-placeholder">Empty</span>
        )}
      </button>
      {!readOnly && value != null && (
        <Button
          variant="ghost"
          size="xs"
          className="property-value-date-clear hover-reveal"
          onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
          title="Clear date"
        >
          ×
        </Button>
      )}
      {isOpen && (
        <DatePickerPopup
          value={isoValue}
          onSelect={handleSelect}
          onClose={() => setIsOpen(false)}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}
