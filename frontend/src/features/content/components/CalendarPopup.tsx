/**
 * Calendar popup feature wrapper
 *
 * Wires the controlled `CalendarPopup` base component to Notees stores and
 * daily-page API calls. Used by the top bar and anywhere else the calendar
 * popup appears.
 */
import { useCallback } from 'react';
import * as nodesApi from '@/api/nodes';
import { CalendarPopup as CalendarPopupBase } from '@/components/ui';
import { useExistingDailyPages } from '@/features/content';
import { useNavigationStore, useSettingsStore } from '@/stores';

export interface CalendarPopupProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** When incremented, navigates the calendar to today's month with accent pulse */
  goToTodaySignal?: number;
}

function toIsoLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function CalendarPopup({ isOpen, onClose, anchorRef, goToTodaySignal }: CalendarPopupProps) {
  const openNode = useNavigationStore((state) => state.openNode);
  const firstDayOfWeek = useSettingsStore((state) => state.firstDayOfWeek);
  const { data: dailyPages = [] } = useExistingDailyPages();

  const handleSelectDay = useCallback(async (date: Date) => {
    const node = await nodesApi.getOrCreateDaily(toIsoLocal(date));
    openNode(node.id);
    onClose();
  }, [openNode, onClose]);

  const handleSelectMonth = useCallback(async (year: number, month: number) => {
    const node = await nodesApi.getOrCreateMonthly(year, month + 1);
    openNode(node.id);
    onClose();
  }, [openNode, onClose]);

  const handleSelectYear = useCallback(async (year: number) => {
    const node = await nodesApi.getOrCreateYearly(year);
    openNode(node.id);
    onClose();
  }, [openNode, onClose]);

  return (
    <CalendarPopupBase
      isOpen={isOpen}
      onClose={onClose}
      anchorRef={anchorRef}
      goToTodaySignal={goToTodaySignal}
      firstDayOfWeek={firstDayOfWeek}
      dailyPages={dailyPages}
      onSelectDay={handleSelectDay}
      onSelectMonth={handleSelectMonth}
      onSelectYear={handleSelectYear}
    />
  );
}
