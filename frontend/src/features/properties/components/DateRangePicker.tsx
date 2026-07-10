/**
 * DateRangePicker — modal for selecting day, month, or year ranges.
 *
 * The start/end fields open the same drill-down `DatePickerPopup` used by the
 * `/date` slash command, seeded at the matching level (year→years, month→months,
 * day→days) so the whole app shares one calendar.
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { DatePickerPopup } from '@/features/content';
import type { CalendarMode } from '@/components/ui';
import type { DateRangeGranularity, DateRangeValue } from '@/utils/dateRange';
import { formatDateRange, buildDateRangeValue } from '@/utils/dateRange';
import './DateRangePicker.css';

interface DateRangePickerProps {
  initialValue?: DateRangeValue | null;
  onChange: (value: DateRangeValue | null) => void;
  onClose: () => void;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIso(iso: string): { year: number; month: number; day: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10), day: parseInt(m[3], 10) };
}

function modeForGranularity(granularity: DateRangeGranularity): CalendarMode {
  if (granularity === 'year') return 'years';
  if (granularity === 'month') return 'months';
  return 'days';
}

function formatField(iso: string, granularity: DateRangeGranularity): string {
  const p = parseIso(iso);
  if (!p) return iso;
  if (granularity === 'year') return String(p.year);
  if (granularity === 'month') return `${MONTHS[p.month - 1]} ${p.year}`;
  return new Date(p.year, p.month - 1, p.day).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function DateRangePicker({ initialValue, onChange, onClose }: DateRangePickerProps) {
  const [granularity, setGranularity] = useState<DateRangeGranularity>(initialValue?.granularity ?? 'day');
  const [start, setStart] = useState(initialValue?.start ?? todayIso());
  const [end, setEnd] = useState(initialValue?.end ?? todayIso());
  const [error, setError] = useState<string | null>(null);
  const [openField, setOpenField] = useState<'start' | 'end' | null>(null);

  const startRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLButtonElement>(null);

  const preview = useMemo(() => {
    try {
      return formatDateRange(buildDateRangeValue(start, end, granularity));
    } catch {
      return '';
    }
  }, [start, end, granularity]);

  const handleCommit = useCallback(() => {
    try {
      const value = buildDateRangeValue(start, end, granularity);
      setError(null);
      onChange(value);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid range');
    }
  }, [start, end, granularity, onChange, onClose]);

  const handleClear = useCallback(() => {
    onChange(null);
    onClose();
  }, [onChange, onClose]);

  const activeValue = openField === 'end' ? end : start;
  const activeAnchor = (openField === 'end' ? endRef : startRef) as React.RefObject<HTMLElement | null>;

  const handleFieldSelect = useCallback(
    (iso: string) => {
      if (openField === 'end') setEnd(iso);
      else setStart(iso);
      setOpenField(null);
    },
    [openField],
  );

  return (
    <>
      <Modal
        isOpen
        onClose={onClose}
        title="Select date range"
        size="sm"
        footer={(
          <div className="date-range-footer">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            {initialValue && (
              <Button variant="ghost" size="sm" onClick={handleClear}>Clear</Button>
            )}
            <Button variant="primary" size="sm" onClick={handleCommit}>Save</Button>
          </div>
        )}
      >
        <div className="date-range-picker">
          <Tabs value={granularity} onChange={(tab) => setGranularity(tab as DateRangeGranularity)}>
            <Tabs.List>
              <Tabs.Tab value="day">Day</Tabs.Tab>
              <Tabs.Tab value="month">Month</Tabs.Tab>
              <Tabs.Tab value="year">Year</Tabs.Tab>
            </Tabs.List>
          </Tabs>

          <div className="date-range-inputs">
            <div className="date-range-row">
              <div className="date-range-field">
                <span>Start</span>
                <button
                  ref={startRef}
                  type="button"
                  className="date-range-trigger"
                  onClick={() => setOpenField((f) => (f === 'start' ? null : 'start'))}
                >
                  {formatField(start, granularity)}
                </button>
              </div>
              <div className="date-range-field">
                <span>End</span>
                <button
                  ref={endRef}
                  type="button"
                  className="date-range-trigger"
                  onClick={() => setOpenField((f) => (f === 'end' ? null : 'end'))}
                >
                  {formatField(end, granularity)}
                </button>
              </div>
            </div>
          </div>

          {preview && (
            <div className="date-range-preview">
              {preview}
            </div>
          )}

          {error && (
            <div className="date-range-error">
              {error}
            </div>
          )}
        </div>
      </Modal>

      {openField && (
        <DatePickerPopup
          value={activeValue}
          initialMode={modeForGranularity(granularity)}
          anchorRef={activeAnchor}
          className="date-range-calendar"
          onSelect={handleFieldSelect}
          onClose={() => setOpenField(null)}
        />
      )}
    </>
  );
}
