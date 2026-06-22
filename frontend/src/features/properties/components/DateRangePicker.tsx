/**
 * DateRangePicker — modal for selecting day, month, or year ranges.
 */

import { useState, useCallback, useMemo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
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

export function DateRangePicker({ initialValue, onChange, onClose }: DateRangePickerProps) {
  const [granularity, setGranularity] = useState<DateRangeGranularity>(initialValue?.granularity ?? 'day');
  const [start, setStart] = useState(initialValue?.start ?? todayIso());
  const [end, setEnd] = useState(initialValue?.end ?? todayIso());
  const [error, setError] = useState<string | null>(null);

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

  const startParsed = parseIso(start);
  const endParsed = parseIso(end);

  const renderDayInputs = () => (
    <div className="date-range-row">
      <label className="date-range-field">
        <span>Start</span>
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="date-range-input"
        />
      </label>
      <label className="date-range-field">
        <span>End</span>
        <input
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="date-range-input"
        />
      </label>
    </div>
  );

  const renderMonthInputs = () => {
    const startMonth = startParsed ? startParsed.month : 1;
    const startYear = startParsed ? startParsed.year : new Date().getFullYear();
    const endMonth = endParsed ? endParsed.month : 1;
    const endYear = endParsed ? endParsed.year : new Date().getFullYear();

    const setMonth = (which: 'start' | 'end', year: number, month: number) => {
      const iso = `${year}-${String(month).padStart(2, '0')}-01`;
      if (which === 'start') setStart(iso);
      else setEnd(iso);
    };

    return (
      <div className="date-range-row">
        <label className="date-range-field">
          <span>Start</span>
          <div className="date-range-month">
            <select
              value={startMonth}
              onChange={(e) => setMonth('start', startYear, parseInt(e.target.value, 10))}
              className="date-range-select"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <input
              type="number"
              value={startYear}
              onChange={(e) => setMonth('start', parseInt(e.target.value, 10) || 0, startMonth)}
              className="date-range-year-input"
              min={1900}
              max={2200}
            />
          </div>
        </label>
        <label className="date-range-field">
          <span>End</span>
          <div className="date-range-month">
            <select
              value={endMonth}
              onChange={(e) => setMonth('end', endYear, parseInt(e.target.value, 10))}
              className="date-range-select"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <input
              type="number"
              value={endYear}
              onChange={(e) => setMonth('end', parseInt(e.target.value, 10) || 0, endMonth)}
              className="date-range-year-input"
              min={1900}
              max={2200}
            />
          </div>
        </label>
      </div>
    );
  };

  const renderYearInputs = () => {
    const startYear = startParsed ? startParsed.year : new Date().getFullYear();
    const endYear = endParsed ? endParsed.year : new Date().getFullYear();

    const setYear = (which: 'start' | 'end', year: number) => {
      const iso = `${year}-01-01`;
      if (which === 'start') setStart(iso);
      else setEnd(iso);
    };

    return (
      <div className="date-range-row">
        <label className="date-range-field">
          <span>Start</span>
          <input
            type="number"
            value={startYear}
            onChange={(e) => setYear('start', parseInt(e.target.value, 10) || 0)}
            className="date-range-year-input"
            min={1900}
            max={2200}
          />
        </label>
        <label className="date-range-field">
          <span>End</span>
          <input
            type="number"
            value={endYear}
            onChange={(e) => setYear('end', parseInt(e.target.value, 10) || 0)}
            className="date-range-year-input"
            min={1900}
            max={2200}
          />
        </label>
      </div>
    );
  };

  return (
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
          {granularity === 'day' && renderDayInputs()}
          {granularity === 'month' && renderMonthInputs()}
          {granularity === 'year' && renderYearInputs()}
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
  );
}
