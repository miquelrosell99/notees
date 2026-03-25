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
import { 
  mdiMenu, 
  mdiCalendar, 
  mdiDockRight,
  mdiNoteTextOutline,
  mdiCommentOutline,
  mdiUndo,
  mdiRedo,
  mdiArrowLeft,
  mdiArrowRight,
  mdiDeleteOutline,
} from '@mdi/js';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigationStore, useModalStore, useNavigationHistoryStore, useUndoStore } from '@/stores';
import { useCommentCount, useDailyNote } from '@/hooks';
import { Button } from '../core/Button';
import type { ButtonBadge } from '../core/Button';
import { CalendarPopup } from '../core/CalendarPopup';
import { Card } from '../core/Card';
import { ContextMenu } from '../core/ContextMenu';
import type { ContextMenuItem } from '../core/ContextMenu';
import { Scratchpad } from './Scratchpad';
import { AccountMenu } from './AccountMenu';
import { UserSettingsModal } from './UserSettingsModal';
import './TopBar.css';

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
  const [scratchpadEntryCount, setScratchpadEntryCount] = useState(0);
  const [goToTodaySignal, setGoToTodaySignal] = useState(0);

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
    { id: 'clear', label: 'Clear history', icon: mdiDeleteOutline, danger: true, onClick: () => { clearHistory(); setUndoMenuOpen(false); } },
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
    { id: 'clear', label: 'Clear history', icon: mdiDeleteOutline, danger: true, onClick: () => { clearHistory(); setRedoMenuOpen(false); } },
  ], [redoEntries, performRedoTo, queryClient, clearHistory]);

  // Pre-fetch today's note for shift+click
  const { refetch: refetchToday } = useDailyNote(new Date());

  const currentNodeId = useNavigationStore(s => s.currentNodeId);
  const sidebarCards = useNavigationStore(s => s.sidebarCards);
  
  // Comment count for the active node
  const { data: commentCount } = useCommentCount(currentNodeId);

  // Build badges for the right sidebar toggle button
  const sidebarBadges = useMemo(() => {
    const badges: ButtonBadge[] = [];
    if (commentCount && commentCount > 0) {
      badges.push({ icon: mdiCommentOutline, position: 'bottom-right' });
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
            icon={mdiMenu}
            variant="ghost"
            size="sm"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            className="menu-toggle"
          />
        
          <h1 className="app-title">Notees</h1>
        </div>
      
        <div className="top-bar-center">
          {/* Search removed - use Ctrl+K */}
        </div>
      
        <div className="top-bar-right">
        {/* Back / Forward navigation */}
        <div className="nav-arrows">
          <Button
            icon={mdiArrowLeft}
            variant="ghost"
            size="sm"
            onClick={goBack}
            disabled={!canGoBack}
            aria-label="Go back"
            title="Go back"
            className="toolbar-btn"
          />
          <Button
            icon={mdiArrowRight}
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
          icon={mdiUndo}
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
          icon={mdiRedo}
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
              position={{ x: rect.left, y: rect.bottom + 4 }}
              onClose={() => setUndoMenuOpen(false)}
              title="Undo history"
            />
          );
        })()}

        {/* Redo history dropdown */}
        {redoMenuOpen && redoMenuItems.length > 0 && redoBtnRef.current && (() => {
          const rect = redoBtnRef.current!.getBoundingClientRect();
          return (
            <ContextMenu
              items={redoMenuItems}
              position={{ x: rect.left, y: rect.bottom + 4 }}
              onClose={() => setRedoMenuOpen(false)}
              title="Redo history"
            />
          );
        })()}

        <div className="toolbar-separator" />

        {/* Scratchpad button */}
        <Button
          ref={scratchpadBtnRef}
          icon={mdiNoteTextOutline}
          variant="ghost"
          size="sm"
          active={isScratchpadOpen}
          onClick={toggleScratchpad}
          aria-label="Open scratchpad"
          title="Scratchpad"
          className="toolbar-btn"
          badges={scratchpadEntryCount > 0 ? [{ count: scratchpadEntryCount, position: 'top-right' }] : undefined}
        />
        
        {/* Calendar button */}
        <div className="top-bar-calendar-container">
          <Button 
            ref={calendarBtnRef}
            icon={mdiCalendar}
            variant="ghost"
            size="sm"
            onClick={useCallback(async (e: React.MouseEvent) => {
              if (e.shiftKey) {
                const result = await refetchToday();
                if (result.data) openNode(result.data.id);
              } else {
                toggleCalendar();
              }
            }, [refetchToday, openNode, toggleCalendar])}
            aria-label="Open calendar"
            title="Open calendar (Shift+click: go to today)"
            className="toolbar-btn"
          />
          <CalendarPopup 
            isOpen={isCalendarOpen} 
            onClose={() => setCalendarOpen(false)}
            anchorRef={calendarBtnRef as React.RefObject<HTMLElement>}
            goToTodaySignal={goToTodaySignal}
          />
        </div>
        
        {/* Right sidebar toggle button */}
        <Button
          icon={mdiDockRight}
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
    </Card>
  );
}
