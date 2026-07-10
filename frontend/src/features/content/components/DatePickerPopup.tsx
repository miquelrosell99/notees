/**
 * DatePickerPopup feature wrapper
 *
 * Wires the controlled `DatePickerPopup` base component to Notees settings and
 * daily-page data. Used by date property editors.
 */
import { DatePickerPopup as DatePickerPopupBase, type CalendarMode } from '@/components/ui';
import { useExistingDailyPages } from '@/features/content';
import { useSettingsStore } from '@/stores';

export interface DatePickerPopupProps {
  /** Currently selected ISO date (YYYY-MM-DD) or empty */
  value?: string;
  /** Called when the user picks a date — receives YYYY-MM-DD */
  onSelect: (isoDate: string) => void;
  /** Called when the popup should close */
  onClose: () => void;
  /** Ref to the anchor element for positioning */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Initial drill-down level (defaults to the day grid) */
  initialMode?: CalendarMode;
  /** Extra class on the popup root (e.g. to raise z-index when layered over a modal) */
  className?: string;
}

export function DatePickerPopup({ value, onSelect, onClose, anchorRef, initialMode, className }: DatePickerPopupProps) {
  const firstDayOfWeek = useSettingsStore((s) => s.firstDayOfWeek);
  const { data: dailyPages = [] } = useExistingDailyPages();

  return (
    <DatePickerPopupBase
      value={value}
      onSelect={onSelect}
      onClose={onClose}
      anchorRef={anchorRef}
      initialMode={initialMode}
      className={className}
      firstDayOfWeek={firstDayOfWeek}
      dailyPages={dailyPages}
    />
  );
}
