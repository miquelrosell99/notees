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
import { useRef, useCallback, useState, useMemo } from 'react';
import { 
  mdiMenu, 
  mdiCalendar, 
  mdiPlus, 
  mdiMap, 
  mdiDockRight,
  mdiNoteEditOutline,
  mdiCommentOutline
} from '@mdi/js';
import { useAppStore } from '@/stores';
import { useDailyNote, useCommentCount } from '@/hooks';
import { Button } from '../core/Button';
import type { ButtonBadge } from '../core/Button';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { CalendarPopup } from '../core/CalendarPopup';
import { QuickAddPanel } from '../quickadd/QuickAddPanel';
import { Card } from '../core/Card';
import { Scratchpad } from './Scratchpad';
import { AccountMenu } from './AccountMenu';
import { UserSettingsModal } from './UserSettingsModal';
import './TopBar.css';

export function TopBar() {
  const { 
    toggleSidebar,
    isCalendarOpen, 
    toggleCalendar, 
    setCalendarOpen,
    isQuickAddOpen,
    setQuickAddOpen,
    openNode,
    isMinimapOpen,
    toggleMinimap,
    toggleRightSidebar,
    rightSidebarOpen,
    isScratchpadOpen,
    toggleScratchpad,
    setScratchpadOpen,
  } = useAppStore();
  const calendarBtnRef = useRef<HTMLButtonElement>(null);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);

  const currentNodeId = useAppStore(s => s.currentNodeId);
  const sidebarCards = useAppStore(s => s.sidebarCards);
  
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
  
  // Pre-fetch today's note (this will create it if needed when accessed)
  const { refetch: refetchToday } = useDailyNote(new Date());
  
  const handleTodayClick = useCallback(async () => {
    // Refetch to ensure we have the latest (or create if needed)
    const result = await refetchToday();
    if (result.data) {
      openNode(result.data.id);
    }
  }, [refetchToday, openNode]);

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
          icon={mdiNoteEditOutline}
          variant="ghost"
          size="sm"
          active={isScratchpadOpen}
          onClick={toggleScratchpad}
          aria-label="Open scratchpad"
          title="Scratchpad (daily notes)"
          className="toolbar-btn"
        />
        
        {/* Today button */}
        <Button
          icon={mdiCalendar}
          variant="ghost"
          size="sm"
          onClick={handleTodayClick}
          aria-label="Go to Today"
          title="Go to Today"
          className="toolbar-btn today-btn"
        />
        
        {/* Calendar button */}
        <div className="top-bar-calendar-container">
          <Button 
            ref={calendarBtnRef}
            icon={mdiCalendar}
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
          />
        </div>
        
        {/* Quick add button with panel */}
        <ButtonWithPanel
          icon={mdiPlus}
          variant="ghost"
          size="sm"
          panelPosition="bottom"
          panelAlignment="end"
          panelWidth={320}
          tooltip="Quick add (Ctrl+N)"
          buttonClassName="toolbar-btn"
          open={isQuickAddOpen}
          onOpenChange={setQuickAddOpen}
        >
          {(closePanel: () => void) => <QuickAddPanel onClose={closePanel} />}
        </ButtonWithPanel>
        
        {/* Minimap toggle button */}
        <Button
          icon={mdiMap}
          variant="ghost"
          size="sm"
          active={isMinimapOpen}
          onClick={toggleMinimap}
          aria-label="Toggle minimap"
          title="Toggle minimap"
          className="toolbar-btn"
        />
        
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
      />
      
      {/* User Settings Modal */}
      <UserSettingsModal
        isOpen={isUserSettingsOpen}
        onClose={() => setIsUserSettingsOpen(false)}
      />
    </Card>
  );
}
