/**
 * InlineDateRange — React component rendered inside InlineDateRangeNode.
 */

import { useCallback, useState } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';
import { getOperationRuntime } from '@/runtime';
import { formatDateRange } from '@/utils/dateRange';
import { DateRangePicker } from '@/features/properties/components/DateRangePicker';
import type { DateRangeValue } from '@/utils/dateRange';
import './InlineDateRange.css';

interface InlineDateRangeProps {
  start: string;
  end: string;
  granularity: 'day' | 'month' | 'year';
  startUuid: string;
  endUuid: string;
  label?: string;
  onChange?: (value: DateRangeValue) => void;
}

export function InlineDateRange({
  start,
  end,
  granularity,
  startUuid,
  endUuid,
  label,
  onChange,
}: InlineDateRangeProps) {
  const openNode = useNavigationStore((s) => s.openNode);
  const [isEditing, setIsEditing] = useState(false);

  const displayLabel = label || formatDateRange({ start, end, granularity, start_uuid: startUuid, end_uuid: endUuid });

  const handleClick = useCallback(() => {
    const runtime = getOperationRuntime();
    const node = runtime.getNode(startUuid);
    if (node?.blockId != null) {
      openNode(node.blockId);
    }
  }, [openNode, startUuid]);

  const handleEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
  }, []);

  return (
    <>
      <span
        className="inline-date-range-pill"
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
        title="Date range"
      >
        <span className="inline-date-range-text">{displayLabel}</span>
        <button
          type="button"
          className="inline-date-range-edit"
          onClick={handleEdit}
          aria-label="Edit date range"
          title="Edit"
        >
          ✎
        </button>
      </span>
      {isEditing && (
        <DateRangePicker
          initialValue={{ start, end, granularity, start_uuid: startUuid, end_uuid: endUuid }}
          onChange={(newValue) => {
            if (newValue) onChange?.(newValue);
            setIsEditing(false);
          }}
          onClose={() => setIsEditing(false)}
        />
      )}
    </>
  );
}
