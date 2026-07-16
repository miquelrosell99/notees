/**
 * MobileLayout – Obsidian-style layout for phones/small tablets.
 *
 * Structure (portrait or landscape):
 *   [TopBar]
 *   [Full-width content]
 *   [Left sidebar – off-canvas overlay drawer, slides in from left]
 *   [Right sidebar content – "References" bottom sheet, swipe-to-dismiss]
 *
 * The right sidebar's content (sidebar cards, linked references, local
 * graph) is available on mobile as a bottom sheet: tap the mdi-dock-right
 * button in the top bar to open it; swipe down, tap the backdrop, or use
 * the close button to dismiss it.
 *
 * Interaction model (mirrors Obsidian mobile):
 *   • Tap hamburger  → open sidebar drawer
 *   • Tap note title in sidebar → navigate + drawer auto-closes
 *   • Tap backdrop   → close drawer
 *   • Swipe-right from left edge (≤28 px) → open sidebar
 *   • Drag drawer left → close sidebar
 *   • Tap mdi-dock-right → open References sheet
 *   • Drag sheet down  → close References sheet
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigationStore, useModalStore } from '@/stores';
import { useInputContext } from '@/stores/inputContext';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { CardMobileLayoutProvider } from '@/components/ui/CardMobileLayoutContext';
import { RightSidebarCards } from '@/features/sidebar';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { TopBar } from './TopBar';
import './MobileLayout.css';

/** Touch gesture thresholds (px) */
const EDGE_ZONE_WIDTH = 28;
const SWIPE_MIN_DISTANCE = 60;
const VERTICAL_RATIO = 0.7;
const DRAG_VELOCITY_THRESHOLD = 0.5; // px/ms
const SNAP_DURATION_MS = 300;

interface MobileLayoutProps {
  /** Called when the user navigates to a new node (for auto-close of drawer). */
  currentNodeUuid: string | null;
}

export function MobileLayout({ currentNodeUuid }: MobileLayoutProps) {
  const isSidebarCollapsed = useNavigationStore(s => s.isSidebarCollapsed);
  const toggleSidebar = useNavigationStore(s => s.toggleSidebar);
  const rightSidebarOpen = useNavigationStore(s => s.rightSidebarOpen);
  const toggleRightSidebar = useNavigationStore(s => s.toggleRightSidebar);
  const setScratchpadOpen = useModalStore(s => s.setScratchpadOpen);
  const drawerOpen = !isSidebarCollapsed;
  const drawerRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const [dragMode, setDragMode] = useState<'open' | 'close' | null>(null);

  // Trap focus inside the mobile drawer while it is open
  useFocusTrap(drawerRef, {
    enabled: drawerOpen,
    onEscape: toggleSidebar,
    restoreFocus: true,
  });

  // Auto-close drawer and References sheet when user taps a note — mirrors Obsidian
  const prevNodeIdRef = useRef(currentNodeUuid);
  useEffect(() => {
    if (currentNodeUuid !== prevNodeIdRef.current) {
      if (drawerOpen) toggleSidebar();
      if (rightSidebarOpen) toggleRightSidebar();
    }
    prevNodeIdRef.current = currentNodeUuid;
  }, [currentNodeUuid, drawerOpen, rightSidebarOpen, toggleSidebar, toggleRightSidebar]);

  // Close drawer when any modal / popup overlay opens
  useEffect(() => {
    return useInputContext.subscribe((state, prevState) => {
      if (!prevState.isOverlayOpen && state.isOverlayOpen && drawerOpen) {
        toggleSidebar();
      }
    });
  }, [drawerOpen, toggleSidebar]);

  // The References sheet and the drawer must never both be open. The overlay
  // subscription above already closes the drawer when the sheet opens; this
  // covers the reverse path (edge swipe opening the drawer over the sheet).
  useEffect(() => {
    if (drawerOpen && rightSidebarOpen) toggleRightSidebar();
  }, [drawerOpen, rightSidebarOpen, toggleRightSidebar]);

  // Fade in the backdrop when the drawer is open and not being dragged.
  useEffect(() => {
    if (drawerOpen && !dragMode && backdropRef.current) {
      backdropRef.current.style.setProperty('--drawer-backdrop-opacity', '1');
    }
  }, [drawerOpen, dragMode]);

  // Drag-to-open / drag-to-close sidebar
  const dragRef = useRef<{
    active: boolean;
    mode: 'open' | 'close' | null;
    startX: number;
    startY: number;
    currentX: number;
    startTime: number;
    drawerWidth: number;
  }>({
    active: false,
    mode: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    startTime: 0,
    drawerWidth: 0,
  });
  const snapTimeoutRef = useRef<number | null>(null);

  const clearSnapTimeout = useCallback(() => {
    if (snapTimeoutRef.current) {
      window.clearTimeout(snapTimeoutRef.current);
      snapTimeoutRef.current = null;
    }
  }, []);

  const setDragVars = useCallback((offset: number, opacity: number) => {
    if (drawerRef.current) {
      drawerRef.current.style.setProperty('--drawer-drag-offset', `${offset}px`);
    }
    if (backdropRef.current) {
      backdropRef.current.style.setProperty('--drawer-backdrop-opacity', String(opacity));
    }
  }, []);

  const resetDragVars = useCallback(() => {
    if (drawerRef.current) {
      drawerRef.current.style.removeProperty('--drawer-drag-offset');
      drawerRef.current.classList.remove('mobile-drawer--dragging');
    }
    if (backdropRef.current) {
      backdropRef.current.style.removeProperty('--drawer-backdrop-opacity');
      backdropRef.current.classList.remove('mobile-drawer-backdrop--dragging');
    }
  }, []);

  useEffect(() => {
    let rafId: number | null = null;

    const onTouchStart = (e: TouchEvent) => {
      if (!drawerRef.current) return;
      const touch = e.touches[0];
      const startX = touch.clientX;
      const startY = touch.clientY;
      const target = e.target as HTMLElement;

      let mode: 'open' | 'close' | null = null;
      if (!drawerOpen && startX < EDGE_ZONE_WIDTH) {
        mode = 'open';
      } else if (drawerOpen && (drawerRef.current.contains(target) || backdropRef.current?.contains(target))) {
        mode = 'close';
      }

      if (!mode) return;

      clearSnapTimeout();
      const rect = drawerRef.current.getBoundingClientRect();
      dragRef.current = {
        active: true,
        mode,
        startX,
        startY,
        currentX: startX,
        startTime: Date.now(),
        drawerWidth: rect.width,
      };
      setDragMode(mode);

      drawerRef.current.classList.add('mobile-drawer--dragging');
      if (backdropRef.current) {
        backdropRef.current.classList.add('mobile-drawer-backdrop--dragging');
      }
      // Start from current resting position
      setDragVars(0, mode === 'open' ? 0 : 1);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!dragRef.current.active) return;
      const touch = e.touches[0];
      const dx = touch.clientX - dragRef.current.startX;
      const dy = touch.clientY - dragRef.current.startY;

      // Cancel drag if vertical scrolling dominates
      if (Math.abs(dy) > Math.abs(dx) * VERTICAL_RATIO) {
        dragRef.current.active = false;
        resetDragVars();
        setDragMode(null);
        return;
      }

      dragRef.current.currentX = touch.clientX;
      const width = dragRef.current.drawerWidth || 1;
      let offset: number;
      let opacity: number;

      if (dragRef.current.mode === 'open') {
        offset = Math.max(0, Math.min(dx, width));
        opacity = offset / width;
      } else {
        offset = Math.min(0, Math.max(dx, -width));
        opacity = Math.max(0, 1 + offset / width);
      }

      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setDragVars(offset, opacity));
    };

    const onTouchEnd = () => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;

      const dx = dragRef.current.currentX - dragRef.current.startX;
      const dt = Date.now() - dragRef.current.startTime;
      const velocity = dt > 0 ? dx / dt : 0;

      let shouldToggle = false;
      if (dragRef.current.mode === 'open') {
        shouldToggle = dx > SWIPE_MIN_DISTANCE || velocity > DRAG_VELOCITY_THRESHOLD;
      } else {
        shouldToggle = dx < -SWIPE_MIN_DISTANCE || velocity < -DRAG_VELOCITY_THRESHOLD;
      }

      const willBeOpen =
        (dragRef.current.mode === 'open' && shouldToggle) ||
        (dragRef.current.mode === 'close' && !shouldToggle);

      // Re-enable CSS transitions and snap to the resting state
      if (drawerRef.current) {
        drawerRef.current.classList.remove('mobile-drawer--dragging');
      }
      if (backdropRef.current) {
        backdropRef.current.classList.remove('mobile-drawer-backdrop--dragging');
      }
      setDragVars(0, willBeOpen ? 1 : 0);

      if (shouldToggle) {
        toggleSidebar();
      }

      // Keep the backdrop mounted while the snap animation runs, then unmount if closed
      snapTimeoutRef.current = window.setTimeout(() => {
        setDragMode(null);
        resetDragVars();
      }, SNAP_DURATION_MS);
    };

    const onTouchCancel = () => {
      if (!dragRef.current.active) return;
      dragRef.current.active = false;
      resetDragVars();
      setDragMode(null);
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
      if (rafId) cancelAnimationFrame(rafId);
      clearSnapTimeout();
    };
  }, [drawerOpen, toggleSidebar, clearSnapTimeout, resetDragVars, setDragVars]);

  const showBackdrop = drawerOpen || dragMode !== null;

  return (
    <div className="mobile-canvas">
      {/* ── Top bar ── */}
      <TopBar />

      {/* ── Full-width content ── */}
      <main id="main-content" className="mobile-content">
        <CardMobileLayoutProvider value={true}>
          <MainContent />
        </CardMobileLayoutProvider>
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
      {showBackdrop && (
        <div
          ref={backdropRef}
          className="mobile-drawer-backdrop"
          onClick={toggleSidebar}
          aria-hidden="true"
        />
      )}

      {/* ── Right-sidebar content as a bottom sheet ── */}
      <Modal
        variant="sheet"
        isOpen={rightSidebarOpen}
        onClose={toggleRightSidebar}
        title="References"
        showCloseButton
        className="mobile-references-sheet"
      >
        <RightSidebarCards />
      </Modal>

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
