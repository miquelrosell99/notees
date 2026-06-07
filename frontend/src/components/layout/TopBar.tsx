/**
 * Top navigation bar component
 * 
 * Matches the screenshot UI with:
 * - Hamburger menu on left
 * - App title "Notees" 
 * - Search box in center
 * - Toolbar buttons on right
 * - Node view specific controls (document/bullet mode toggle)
 */
import { useRef, useState, useMemo, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, useModalStore, useNavigationHistoryStore, useUndoStore } from '@/stores';
import { useAutoExportStore } from '@/stores/autoExportStore';
import { useCommentCount, useDailyNote } from '@/hooks';
import { Icon } from '@/components/core/Icon';
import { Button } from '@/components/core/Button';
import type { ButtonBadge } from '@/components/core/Button';
import { CalendarPopup } from '@/components/core/CalendarPopup';
import { Card } from '@/components/core/Card';
import { ContextMenu } from '@/components/core/ContextMenu';
import type { ContextMenuItem } from '@/components/core/ContextMenu';
import { Scratchpad } from './Scratchpad';
import { AccountMenu } from './AccountMenu';
import { UserSettingsModal, SystemSettingsModal } from './Modals';
import { LiveSyncIndicator } from '@/components/collab/LiveSyncIndicator';
import { NotificationBell } from './NotificationBell';
import './TopBar.css';

function AutoExportIndicator() {
  const status = useAutoExportStore(s => s.status);
  const errorMessage = useAutoExportStore(s => s.errorMessage);

  if (status === 'idle') return null;

  const isSpinning = status === 'exporting';
  const isDone = status === 'done';
  const isError = status === 'error';

  const iconPath = isSpinning ? 'mdi mdi-sync' : isDone ? 'mdi mdi-check' : 'mdi mdi-alert-circle-outline';
  const color = isError ? 'var(--color-error)' : isDone ? 'var(--color-success)' : 'var(--color-primary)';
  const title = isSpinning ? 'Exporting to markdown...' : isDone ? 'Exported to markdown' : errorMessage || 'Export failed';

  return (
    <div
      className="auto-export-indicator"
      title={title}
      aria-label={title}
    >
      <Icon
        path={iconPath}
        size={0.8}
        color={color}
        className={isSpinning ? 'auto-export-indicator--spin' : ''}
      />
    </div>
  );
}

export function TopBar() {
  const { 
    toggleSidebar,
    openNode,
    toggleRightSidebar,
    rightSidebarOpen,
  } = useNavigationStore();
  const {
    isCalendarOpen, 
    toggleCalendar, 
    setCalendarOpen,
    isScratchpadOpen,
    toggleScratchpad,
    setScratchpadOpen,
  } = useModalStore();
  const calendarBtnRef = useRef<HTMLButtonElement>(null);
  const scratchpadBtnRef = useRef<HTMLButtonElement>(null);
  const undoBtnRef = useRef<HTMLButtonElement>(null);
  const redoBtnRef = useRef<HTMLButtonElement>(null);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [isSystemSettingsOpen, setIsSystemSettingsOpen] = useState(false);
  const [scratchpadEntryCount, setScratchpadEntryCount] = useState(0);
  const [goToTodaySignal] = useState(0);

  // Navigation history for back/forward buttons
  const canGoBack = useNavigationHistoryStore(s => s.canGoBack);
  const canGoForward = useNavigationHistoryStore(s => s.canGoForward);
  const goBack = useNavigationHistoryStore(s => s.goBack);
  const goForward = useNavigationHistoryStore(s => s.goForward);

  // Global undo/redo
  const queryClient = useQueryClient();
  const canUndo = useUndoStore(s => s.canUndo);
  const canRedo = useUndoStore(s => s.canRedo);
  const undoEntries = useUndoStore(s => s.undoEntries);
  const redoEntries = useUndoStore(s => s.redoEntries);
  const performUndo = useUndoStore(s => s.performUndo);
  const performRedo = useUndoStore(s => s.performRedo);
  const performUndoTo = useUndoStore(s => s.performUndoTo);
  const performRedoTo = useUndoStore(s => s.performRedoTo);
  const refreshStack = useUndoStore(s => s.refreshStack);
  const clearHistory = useUndoStore(s => s.clearHistory);
  const [undoMenuOpen, setUndoMenuOpen] = useState(false);
  const [redoMenuOpen, setRedoMenuOpen] = useState(false);
  
  // Refresh undo stack on mount
  useEffect(() => { refreshStack(); }, [refreshStack]);

  // Build tooltip with description of next action
  const undoTitle = canUndo && undoEntries.length > 0
    ? `Undo: ${undoEntries[0].description} (Ctrl+Z)`
    : 'Undo (Ctrl+Z)';
  const redoTitle = canRedo && redoEntries.length > 0
    ? `Redo: ${redoEntries[0].description} (Ctrl+Y)`
    : 'Redo (Ctrl+Y)';

  // Build context menu items for undo/redo history
  const undoMenuItems: ContextMenuItem[] = useMemo(() => [
    ...undoEntries.map((entry, i) => ({
      id: String(entry.id),
      label: `${i + 1}. ${entry.description}`,
      onClick: () => {
        performUndoTo(queryClient, entry.id);
        setUndoMenuOpen(false);
      },
    })),
    { id: 'sep', label: '', separator: true },
    { id: 'clear', label: 'Clear history', icon: "mdi mdi-delete-outline", danger: true, onClick: () => { clearHistory(); setUndoMenuOpen(false); } },
  ], [undoEntries, performUndoTo, queryClient, clearHistory]);

  const redoMenuItems: ContextMenuItem[] = useMemo(() => [
    ...redoEntries.map((entry, i) => ({
      id: String(entry.id),
      label: `${i + 1}. ${entry.description}`,
      onClick: () => {
        performRedoTo(queryClient, entry.id);
        setRedoMenuOpen(false);
      },
    })),
    { id: 'sep', label: '', separator: true },
    { id: 'clear', label: 'Clear history', icon: "mdi mdi-delete-outline", danger: true, onClick: () => { clearHistory(); setRedoMenuOpen(false); } },
  ], [redoEntries, performRedoTo, queryClient, clearHistory]);

  // Pre-fetch today's note for shift+click
  const { refetch: refetchToday } = useDailyNote(new Date());

  const handleGoToToday = useCallback(async () => {
    const result = await refetchToday();
    if (result.data) openNode(result.data.id);
  }, [refetchToday, openNode]);

  const currentNodeId = useNavigationStore(s => s.currentNodeId);
  const sidebarCards = useNavigationStore(s => s.sidebarCards);
  
  // Comment count for the active node
  const { data: commentCount } = useCommentCount(currentNodeId);

  // Build badges for the right sidebar toggle button
  const sidebarBadges = useMemo(() => {
    const badges: ButtonBadge[] = [];
    if (commentCount && commentCount > 0) {
      badges.push({ icon: "mdi mdi-comment-outline", position: 'bottom-right' });
    }
    if (sidebarCards.length > 0) {
      badges.push({ count: sidebarCards.length, position: 'top-right' });
    }
    return badges;
  }, [commentCount, sidebarCards.length]);
  

  return (
    <Card 
      variant="filled" 
      elevation="none" 
      radius="md" 
      padding={false}
      className="top-bar-card"
    >
      <header className="top-bar">
        <div className="top-bar-left">
          <Button 
            icon={"mdi mdi-menu"}
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            className="menu-toggle"
          />
        
          <h1 className="app-title">Notees</h1>
          <LiveSyncIndicator />
        </div>
      
        <div className="top-bar-center">
          {/* Search removed - use Ctrl+K */}
        </div>
      
        <div className="top-bar-right">
        {/* Back / Forward navigation */}
        <div className="nav-arrows">
          <Button
            icon={"mdi mdi-arrow-left"}
            variant="ghost"
            size="sm"
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="Go back"
            title="Go back"
            className="toolbar-btn"
          />
          <Button
            icon={"mdi mdi-arrow-right"}
            variant="ghost"
            size="sm"
            onClick={goForward}
            disabled={!canGoForward}
            aria-label="Go forward"
            title="Go forward"
            className="toolbar-btn"
          />
        </div>

        <div className="toolbar-separator" />

        {/* Undo button */}
        <Button
          ref={undoBtnRef}
          icon={"mdi mdi-undo"}
          variant="ghost"
          size="sm"
          disabled={!canUndo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => performUndo(queryClient)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (undoEntries.length > 0) setUndoMenuOpen(true);
          }}
          aria-label="Undo"
          title={undoTitle}
          className="toolbar-btn"
        />

        {/* Redo button */}
        <Button
          ref={redoBtnRef}
          icon={"mdi mdi-redo"}
          variant="ghost"
          size="sm"
          disabled={!canRedo}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => performRedo(queryClient)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (redoEntries.length > 0) setRedoMenuOpen(true);
          }}
          aria-label="Redo"
          title={redoTitle}
          className="toolbar-btn"
        />

        {/* Undo history dropdown */}
        {undoMenuOpen && undoMenuItems.length > 0 && undoBtnRef.current && (() => {
          const rect = undoBtnRef.current!.getBoundingClientRect();
          return (
            <ContextMenu
              items={undoMenuItems}
              position={{ x: rect.right, y: rect.bottom + 4 }}
              onClose={() => setUndoMenuOpen(false)}
              title="Undo history"
              alignRight
            />
          );
        })()}

        {/* Redo history dropdown */}
        {redoMenuOpen && redoMenuItems.length > 0 && redoBtnRef.current && (() => {
          const rect = redoBtnRef.current!.getBoundingClientRect();
          return (
            <ContextMenu
              items={redoMenuItems}
              position={{ x: rect.right, y: rect.bottom + 4 }}
              onClose={() => setRedoMenuOpen(false)}
              title="Redo history"
              alignRight
            />
          );
        })()}

        <div className="toolbar-separator" />

        {/* Scratchpad button */}
        <Button
          ref={scratchpadBtnRef}
          icon={"mdi mdi-note-text-outline"}
          variant="ghost"
          size="sm"
          active={isScratchpadOpen}
          onClick={toggleScratchpad}
          aria-label="Open scratchpad"
          title="Scratchpad"
          className="toolbar-btn"
          badges={scratchpadEntryCount > 0 ? [{ count: scratchpadEntryCount, position: 'top-right' }] : undefined}
        />
        
        {/* Today button */}
        <Button
          icon={"mdi mdi-calendar-today"}
          variant="ghost"
          size="sm"
          onClick={handleGoToToday}
          aria-label="Go to today"
          title="Go to today"
          className="toolbar-btn"
        />

        {/* Calendar button */}
        <div className="top-bar-calendar-container">
          <Button 
            ref={calendarBtnRef}
            icon={"mdi mdi-calendar"}
            variant="ghost"
            size="sm"
            onClick={toggleCalendar}
            aria-label="Open calendar"
            title="Open calendar"
            className="toolbar-btn"
          />
          <CalendarPopup 
            isOpen={isCalendarOpen} 
            onClose={() => setCalendarOpen(false)}
            anchorRef={calendarBtnRef as React.RefObject<HTMLElement>}
            goToTodaySignal={goToTodaySignal}
          />
        </div>
        
        {/* Auto-export sync indicator */}
        <AutoExportIndicator />

        {/* Right sidebar toggle button */}
        <Button
          icon={"mdi mdi-dock-right"}
          variant="ghost"
          size="sm"
          active={rightSidebarOpen}
          onClick={toggleRightSidebar}
          aria-label="Toggle right sidebar"
          title="Toggle right sidebar"
          className="toolbar-btn"
          badges={sidebarBadges}
        />
        
        {/* Notification bell */}
        <NotificationBell />

        {/* Account menu */}
        <AccountMenu
          onOpenUserSettings={() => setIsUserSettingsOpen(true)}
          onOpenSystemSettings={() => setIsSystemSettingsOpen(true)}
        />
      </div>
      </header>
      
      <Scratchpad
        isOpen={isScratchpadOpen}
        onClose={() => setScratchpadOpen(false)}
        anchorRef={scratchpadBtnRef}
        onEntryCountChange={setScratchpadEntryCount}
      />
      
      {/* User Settings Modal */}
      <UserSettingsModal
        isOpen={isUserSettingsOpen}
        onClose={() => setIsUserSettingsOpen(false)}
      />

      {/* System Settings Modal */}
      <SystemSettingsModal
        isOpen={isSystemSettingsOpen}
        onClose={() => setIsSystemSettingsOpen(false)}
      />


    </Card>
  );
}
