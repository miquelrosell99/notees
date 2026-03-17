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
import { useRef, useState, useMemo, useCallback } from 'react';
import { 
  mdiMenu, 
  mdiCalendar, 
  mdiDockRight,
  mdiNoteTextOutline,
  mdiCommentOutline
} from '@mdi/js';
import { useNavigationStore, useModalStore } from '@/stores';
import { useCommentCount, useDailyNote } from '@/hooks';
import { Button } from '../core/Button';
import type { ButtonBadge } from '../core/Button';
import { CalendarPopup } from '../core/CalendarPopup';
import { Card } from '../core/Card';
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
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [scratchpadEntryCount, setScratchpadEntryCount] = useState(0);
  const [goToTodaySignal, setGoToTodaySignal] = useState(0);

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
