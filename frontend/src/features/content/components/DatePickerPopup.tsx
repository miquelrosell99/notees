/**
 * DatePickerPopup feature wrapper
 *
 * Wires the controlled `DatePickerPopup` base component to Notees settings and
 * daily-page data. Used by date property editors.
 */
import { DatePickerPopup as DatePickerPopupBase } from '@/components/ui/DatePickerPopup';
import { useExistingDailyPages } from '@/hooks';
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
}

export function DatePickerPopup({ value, onSelect, onClose, anchorRef }: DatePickerPopupProps) {
  const { firstDayOfWeek } = useSettingsStore();
  const { data: dailyPages = [] } = useExistingDailyPages();

  return (
    <DatePickerPopupBase
      value={value}
      onSelect={onSelect}
      onClose={onClose}
      anchorRef={anchorRef}
      firstDayOfWeek={firstDayOfWeek}
      dailyPages={dailyPages}
    />
  );
}
