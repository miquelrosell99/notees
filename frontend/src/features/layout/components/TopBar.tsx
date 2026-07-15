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
import { useRef, useState, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, useModalStore, useUndoStore, useNavigationHistoryStore } from '@/stores';
import { useShallow } from 'zustand/react/shallow';

import { useAutoExportStore } from '@/stores/autoExportStore';
import { useCommentCount } from '@/features/content';
import { Icon, Button } from '@/components/ui';
import type { ButtonBadge } from '@/components/ui/Button';
import { CalendarPopup } from '@/features/content';
import { TasksPopup, useTasksPopupData } from '@/features/tasks';
import { Card } from '@/components/ui/Card';
import { ContextMenu } from '@/components/ui/ContextMenu';
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import { Scratchpad } from './Scratchpad';
import { LiveSyncIndicator } from '@/features/collab';

import './TopBar.css';
import { getRuntimeEventBus } from '@/runtime/eventBus';


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
    toggleRightSidebar,
    rightSidebarOpen,
    toggleFocusMode,
    viewMode,
  } = useNavigationStore(
    useShallow((s) => ({
      toggleSidebar: s.toggleSidebar,
      toggleRightSidebar: s.toggleRightSidebar,
      rightSidebarOpen: s.rightSidebarOpen,
      toggleFocusMode: s.toggleFocusMode,
      viewMode: s.viewMode,
    }))
  );
  const {
    isCalendarOpen,
    toggleCalendar,
    setCalendarOpen,
    isTasksPopupOpen,
    toggleTasksPopup,
    setTasksPopupOpen,
    isScratchpadOpen,
    toggleScratchpad,
    setScratchpadOpen,
  } = useModalStore(
    useShallow((s) => ({
      isCalendarOpen: s.isCalendarOpen,
      toggleCalendar: s.toggleCalendar,
      setCalendarOpen: s.setCalendarOpen,
      isTasksPopupOpen: s.isTasksPopupOpen,
      toggleTasksPopup: s.toggleTasksPopup,
      setTasksPopupOpen: s.setTasksPopupOpen,
      isScratchpadOpen: s.isScratchpadOpen,
      toggleScratchpad: s.toggleScratchpad,
      setScratchpadOpen: s.setScratchpadOpen,
    }))
  );
  const calendarBtnRef = useRef<HTMLButtonElement>(null);
  const tasksBtnRef = useRef<HTMLButtonElement>(null);
  const scratchpadBtnRef = useRef<HTMLButtonElement>(null);
  const undoBtnRef = useRef<HTMLButtonElement>(null);
  const redoBtnRef = useRef<HTMLButtonElement>(null);
  const [scratchpadEntryCount, setScratchpadEntryCount] = useState(0);

  // Browser history navigation for back/forward buttons
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

  // Refresh undo stack on mount and subscribe to runtime changes
  const syncRuntimeState = useUndoStore(s => s.syncRuntimeState);
  useEffect(() => {
    refreshStack();
    const unsubscribe = getRuntimeEventBus().subscribe((event) => {
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
      id: String(entry.nodeUuid),
      label: `${i + 1}. ${entry.description}`,
      onClick: () => {
        performUndoTo(queryClient, entry);
        setUndoMenuOpen(false);
      },
    })),
    { id: 'sep', label: '', separator: true },
    { id: 'clear', label: 'Clear history', icon: "mdi mdi-delete-outline", danger: true, onClick: () => { clearHistory(); setUndoMenuOpen(false); } },
  ], [undoEntries, performUndoTo, queryClient, clearHistory]);

  const redoMenuItems: ContextMenuItem[] = useMemo(() => [
    ...redoEntries.map((entry, i) => ({
      id: String(entry.nodeUuid),
      label: `${i + 1}. ${entry.description}`,
      onClick: () => {
        performRedoTo(queryClient, entry);
        setRedoMenuOpen(false);
      },
    })),
    { id: 'sep', label: '', separator: true },
    { id: 'clear', label: 'Clear history', icon: "mdi mdi-delete-outline", danger: true, onClick: () => { clearHistory(); setRedoMenuOpen(false); } },
  ], [redoEntries, performRedoTo, queryClient, clearHistory]);

  const currentNodeUuid = useNavigationStore(s => s.currentNodeUuid);
  const sidebarCards = useNavigationStore(s => s.sidebarCards);

  // Comment count for the active node
  const { data: commentCount } = useCommentCount(currentNodeUuid);

  // Due-task count for the tasks popup badge
  const { dueCount } = useTasksPopupData();

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
      data-focus-mode={viewMode === 'focus' || undefined}
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

          <span className="app-title">Notees</span>
          <LiveSyncIndicator />
        </div>

        <div className="top-bar-center" />

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

          {/* Tasks popup button */}
          <div className="top-bar-tasks-container">
            <Button
              ref={tasksBtnRef}
              icon={"mdi mdi-checkbox-marked-circle-outline"}
              variant="ghost"
              size="sm"
              active={isTasksPopupOpen}
              onClick={toggleTasksPopup}
              aria-label="Open tasks"
              title="Open tasks"
              className="toolbar-btn"
              badges={dueCount > 0 ? [{ count: dueCount, position: 'top-right' }] : undefined}
            />
            <TasksPopup
              isOpen={isTasksPopupOpen}
              onClose={() => setTasksPopupOpen(false)}
              anchorRef={tasksBtnRef as React.RefObject<HTMLElement>}
            />
          </div>

          {/* Calendar button */}
          <div className="top-bar-calendar-container">
            <Button
              ref={calendarBtnRef}
              icon={"mdi mdi-calendar"}
              variant="ghost"
              size="sm"
              active={isCalendarOpen}
              onClick={toggleCalendar}
              aria-label="Open calendar"
              title="Open calendar"
              className="toolbar-btn"
            />
            <CalendarPopup
              isOpen={isCalendarOpen}
              onClose={() => setCalendarOpen(false)}
              anchorRef={calendarBtnRef as React.RefObject<HTMLElement>}
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

        </div>
      </header>

      <Scratchpad
        isOpen={isScratchpadOpen}
        onClose={() => setScratchpadOpen(false)}
        anchorRef={scratchpadBtnRef}
        onEntryCountChange={setScratchpadEntryCount}
      />

    </Card>
  );
}
