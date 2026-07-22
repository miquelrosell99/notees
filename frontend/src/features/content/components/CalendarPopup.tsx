/**
 * Calendar popup feature wrapper
 *
 * Wires the controlled `CalendarPopup` base component to Notees stores and
 * daily-page API calls. Used by the top bar and anywhere else the calendar
 * popup appears.
 */
import { useCallback } from 'react';
import { CalendarPopup as CalendarPopupBase, type CalendarMode } from '@/components/ui';
import { useExistingDailyPages } from '@/features/content';
import {
  getOrCreateDailyNoteClient,
  getOrCreateMonthlyNoteClient,
  getOrCreateYearlyNoteClient,
} from '@/features/content/hooks/useNodeDateQueries';
import { useNavigationStore, useSettingsStore } from '@/stores';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';

export interface CalendarPopupProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** When incremented, navigates the calendar to today's month with accent pulse */
  goToTodaySignal?: number;
  /** Initial drill-down level (defaults to the day grid) */
  initialMode?: CalendarMode;
}

function toIsoLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function CalendarPopup({ isOpen, onClose, anchorRef, goToTodaySignal, initialMode }: CalendarPopupProps) {
  const openNode = useNavigationStore((state) => state.openNode);
  const firstDayOfWeek = useSettingsStore((state) => state.firstDayOfWeek);
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { data: dailyPages = [] } = useExistingDailyPages();

  const handleSelectDay = useCallback(async (date: Date) => {
    if (!workspaceUuid) return;
    const client = getWorkspaceStoreClient(workspaceUuid);
    if (!client) return;
    const node = await getOrCreateDailyNoteClient(client, toIsoLocal(date));
    openNode(node.uuid);
    onClose();
  }, [openNode, onClose, workspaceUuid]);

  const handleSelectMonth = useCallback(async (year: number, month: number) => {
    if (!workspaceUuid) return;
    const client = getWorkspaceStoreClient(workspaceUuid);
    if (!client) return;
    const node = await getOrCreateMonthlyNoteClient(client, year, month + 1);
    openNode(node.uuid);
    onClose();
  }, [openNode, onClose, workspaceUuid]);

  const handleSelectYear = useCallback(async (year: number) => {
    if (!workspaceUuid) return;
    const client = getWorkspaceStoreClient(workspaceUuid);
    if (!client) return;
    const node = await getOrCreateYearlyNoteClient(client, year);
    openNode(node.uuid);
    onClose();
  }, [openNode, onClose, workspaceUuid]);

  return (
    <CalendarPopupBase
      isOpen={isOpen}
      onClose={onClose}
      anchorRef={anchorRef}
      goToTodaySignal={goToTodaySignal}
      initialMode={initialMode}
      firstDayOfWeek={firstDayOfWeek}
      dailyPages={dailyPages}
      onSelectDay={handleSelectDay}
      onSelectMonth={handleSelectMonth}
      onSelectYear={handleSelectYear}
    />
  );
}
