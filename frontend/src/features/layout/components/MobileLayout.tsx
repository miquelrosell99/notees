/**
 * MobileLayout – Obsidian-style layout for phones/small tablets.
 *
 * Structure (portrait or landscape):
 *   [TopBar]
 *   [Full-width content]
 *   [Left sidebar – off-canvas overlay drawer, slides in from left]
 *
 * The right sidebar is intentionally omitted on mobile.  The linked-
 * references / local-graph data it contains is still reachable via the
 * desktop view — keeping the mobile experience focused.
 *
 * Interaction model (mirrors Obsidian mobile):
 *   • Tap hamburger  → open sidebar drawer
 *   • Tap note title in sidebar → navigate + drawer auto-closes
 *   • Tap backdrop   → close drawer
 *   • Android back   → close drawer first, then navigate back in web history
 *   • Swipe-right from left edge (≤28 px) → open sidebar (optional, low priority)
 */
import { useEffect, useRef } from 'react';
import { useNavigationStore, useModalStore } from '@/stores';
import { reportDrawerStateToAndroid } from '@/hooks';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { Button } from '@/components/ui/Button';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { TopBar } from './TopBar';
import './MobileLayout.css';

/** Touch gesture thresholds (px) */
const EDGE_ZONE_WIDTH = 28;
const SWIPE_MIN_DISTANCE = 60;
const VERTICAL_RATIO = 0.7;

interface MobileLayoutProps {
  /** Called when the user navigates to a new node (for auto-close of drawer). */
  currentNodeId: number | null;
}

export function MobileLayout({ currentNodeId }: MobileLayoutProps) {
  const isSidebarCollapsed = useNavigationStore(s => s.isSidebarCollapsed);
  const toggleSidebar = useNavigationStore(s => s.toggleSidebar);
  const setScratchpadOpen = useModalStore(s => s.setScratchpadOpen);
  const drawerOpen = !isSidebarCollapsed;
  const drawerRef = useRef<HTMLElement | null>(null);

  // Trap focus inside the mobile drawer while it is open
  useFocusTrap(drawerRef, {
    enabled: drawerOpen,
    onEscape: toggleSidebar,
    restoreFocus: true,
  });

  // Keep the Android native back-button handler in sync with drawer state
  useEffect(() => {
    reportDrawerStateToAndroid(drawerOpen);
  }, [drawerOpen]);

  // Auto-close drawer when user taps a note — mirrors Obsidian
  const prevNodeIdRef = useRef(currentNodeId);
  useEffect(() => {
    if (currentNodeId !== prevNodeIdRef.current && drawerOpen) {
      toggleSidebar();
    }
    prevNodeIdRef.current = currentNodeId;
  }, [currentNodeId, drawerOpen, toggleSidebar]);

  // Swipe from left edge opens drawer (right-to-left swipe closes it).
  // We deliberately skip left-edge to avoid Android system gesture conflicts.
  useEffect(() => {
    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dy) > Math.abs(dx) * VERTICAL_RATIO) return; // mostly vertical

      // Swipe right from left edge → open
      if (!drawerOpen && startX < EDGE_ZONE_WIDTH && dx > SWIPE_MIN_DISTANCE) {
        toggleSidebar();
      }
      // Swipe left when open → close
      if (drawerOpen && dx < -SWIPE_MIN_DISTANCE) {
        toggleSidebar();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [drawerOpen, toggleSidebar]);

  return (
    <div className="mobile-canvas">
      {/* ── Top bar ── */}
      <TopBar />

      {/* ── Full-width content ── */}
      <main className="mobile-content">
        <MainContent />
      </main>

      {/* ── Overlay drawer ── */}
      <aside
        ref={drawerRef}
        aria-label="Sidebar"
        className={`mobile-drawer${drawerOpen ? ' mobile-drawer--open' : ''}`}
        aria-hidden={!drawerOpen}
      >
        <Sidebar collapsed={false} />
      </aside>

      {/* ── Scrim backdrop ── */}
      {drawerOpen && (
        <div
          className="mobile-drawer-backdrop"
          onClick={toggleSidebar}
          aria-hidden="true"
        />
      )}

      {/* ── FAB: open Scratchpad ── */}
      {!drawerOpen && (
        <Button
          variant="primary"
          size="lg"
          icon="mdi mdi-plus"
          className="mobile-fab"
          onClick={() => setScratchpadOpen(true)}
          aria-label="Open Scratchpad"
        />
      )}
    </div>
  );
}
