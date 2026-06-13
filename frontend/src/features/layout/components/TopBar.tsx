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
import { useNavigationStore, useModalStore, useUndoStore, useSettingsStore } from '@/stores';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { useAutoExportStore } from '@/stores/autoExportStore';
import { useCommentCount, useDailyNote } from '@/hooks';
import { Icon } from '@/components/ui/Icon';
import { Button } from '@/components/ui/Button';
import type { ButtonBadge } from '@/components/ui/Button';
import { CalendarPopup } from '@/features/content/components/CalendarPopup';
import { Card } from '@/components/ui/Card';
import { ContextMenu } from '@/components/ui/ContextMenu';
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import { Scratchpad } from './Scratchpad';
import { AccountMenu } from './AccountMenu';
import { UserSettingsModal, SystemSettingsModal } from './Modals';
import { LiveSyncIndicator } from '@/features/collab/components/LiveSyncIndicator';
import { TabBar } from './TabBar/TabBar';

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
    toggleFocusMode,
    viewMode,
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

  // Per-tab navigation history for back/forward buttons
  const canGoBack = useNavigationStore(s => s.canGoBack());
  const canGoForward = useNavigationStore(s => s.canGoForward());
  const goBack = useNavigationStore(s => s.goBack);
  const goForward = useNavigationStore(s => s.goForward);
  const activeTabId = useNavigationStore(s => s.activeTabId);
  const tabs = useNavigationStore(s => s.tabs);
  const [navHistoryOpen, setNavHistoryOpen] = useState(false);
  const navHistoryBtnRef = useRef<HTMLButtonElement>(null);
  const tabPosition = useSettingsStore(s => s.tabPosition);

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
  
  // Refresh undo stack on mount and subscribe to runtime changes
  const syncRuntimeState = useUndoStore(s => s.syncRuntimeState);
  useEffect(() => {
    refreshStack();
    const runtime = getNodeGraphRuntime();
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'undo_stack_changed') {
        syncRuntimeState();
      }
    });
    return unsubscribe;
  }, [refreshStack, syncRuntimeState]);

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
          {tabPosition !== 'left' && <TabBar />}
        </div>
      
        <div className="top-bar-right">
        {/* Back / Forward navigation */}
        <div className="nav-arrows">
          <Button
            ref={navHistoryBtnRef}
            icon={"mdi mdi-arrow-left"}
            variant="ghost"
            size="sm"
            onClick={goBack}
            disabled={!canGoBack}
            onContextMenu={(e) => {
              e.preventDefault();
              const activeTab = tabs.find((t) => t.id === activeTabId);
              if (activeTab && activeTab.history.length > 0) setNavHistoryOpen(true);
            }}
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
            onContextMenu={(e) => {
              e.preventDefault();
              const activeTab = tabs.find((t) => t.id === activeTabId);
              if (activeTab && activeTab.history.length > 0) setNavHistoryOpen(true);
            }}
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
        {undoMenuOpen && undoMenuItems.length > 0 && undoBtnRef.current && (
          <ContextMenu
            items={undoMenuItems}
            anchorEl={undoBtnRef.current}
            onClose={() => setUndoMenuOpen(false)}
            title="Undo history"
            alignRight
          />
        )}

        {/* Redo history dropdown */}
        {redoMenuOpen && redoMenuItems.length > 0 && redoBtnRef.current && (
          <ContextMenu
            items={redoMenuItems}
            anchorEl={redoBtnRef.current}
            onClose={() => setRedoMenuOpen(false)}
            title="Redo history"
            alignRight
          />
        )}

        {/* Navigation history dropdown */}
        {navHistoryOpen && navHistoryBtnRef.current && (() => {
          const activeTab = tabs.find((t) => t.id === activeTabId);
          if (!activeTab || activeTab.history.length === 0) return null;
          const navigateToHistoryEntry = useNavigationStore.getState().navigateToHistoryEntry;
          const items: ContextMenuItem[] = activeTab.history.map((entry, i) => ({
            id: `nav-${i}`,
            label: entry.label,
            icon: i === activeTab.historyIndex ? 'mdi mdi-checkbox-marked-circle-outline' : undefined,
            onClick: () => {
              navigateToHistoryEntry(activeTab.id, i);
              setNavHistoryOpen(false);
            },
          }));
          return (
            <ContextMenu
              items={items}
              anchorEl={navHistoryBtnRef.current}
              onClose={() => setNavHistoryOpen(false)}
              title="Tab history"
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

        {/* Focus mode toggle button */}
        <Button
          icon={"mdi mdi-brain"}
          variant="ghost"
          size="sm"
          active={viewMode === 'focus'}
          onClick={toggleFocusMode}
          aria-label="Toggle focus mode"
          title="Toggle focus mode (Ctrl+Shift+F)"
          className="toolbar-btn"
        />

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
