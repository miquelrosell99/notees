/**
 * PresentationOverlay — the kit's fullscreen presentation host.
 *
 * A consumer-agnostic fullscreen surface: children render centered on a dark
 * stage while the overlay owns the presentation input context
 * (ArrowRight/ArrowDown/Space/PageDown → next, ArrowLeft/ArrowUp/PageUp →
 * prev — active only while open), registers Escape with the overlay stack so
 * it closes in LIFO order regardless of DOM focus, traps Tab focus, and
 * keeps auto-hiding chrome: a bottom toolbar (prev / counter / next / exit)
 * that fades after a short idle, plus always-live screen-edge click zones.
 *
 * Sized for two consumers: a slide deck passes `index` / `count` /
 * `onIndexChange`; a chromeless fullscreen surface (e.g. a future whiteboard
 * fullscreen) omits them and keeps Esc / focus trap / auto-hide with its own
 * children. Device state only — nothing here is ever persisted or written.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button.js';
import { useFocusTrap, useOverlaySurface } from './overlay-hooks.js';
import './PresentationOverlay.css';

/** Idle delay before the toolbar fades (pointer/keyboard activity resets it). */
export const PRESENTATION_CHROME_HIDE_MS = 2600;

export interface PresentationOverlayProps {
  /** Whether the overlay is open. */
  isOpen: boolean;
  /** Called for the Exit gesture (Esc, toolbar button). */
  onClose: () => void;
  /** Current slide index (omit when the consumer has no slide stream). */
  index?: number | undefined;
  /** Total slides — when omitted the toolbar hides counter / prev / next. */
  count?: number | undefined;
  onIndexChange?: ((index: number) => void) | undefined;
  /** The surface content (one slide, or any fullscreen body). */
  children: ReactNode;
  /** Accessible label for the stage region. */
  ariaLabel?: string | undefined;
  className?: string | undefined;
}

export function PresentationOverlay({
  isOpen,
  onClose,
  index = 0,
  count = undefined,
  onIndexChange = undefined,
  children,
  ariaLabel = 'Presentation',
  className = '',
}: PresentationOverlayProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const hasSlides = count !== undefined && count > 0;
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);

  // Escape closes via the shared overlay stack (LIFO with modals/menus above).
  useOverlaySurface({
    type: 'modal',
    enabled: isOpen,
    onClose,
  });

  useFocusTrap(hostRef, {
    enabled: isOpen,
    onEscape: undefined,
    initialFocusRef: hostRef,
  });

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  /** Pointer or keyboard activity: show the chrome, restart the idle timer. */
  const pokeChrome = useCallback(() => {
    setChromeVisible(true);
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(
      () => setChromeVisible(false),
      PRESENTATION_CHROME_HIDE_MS,
    );
  }, [clearHideTimer]);

  useEffect(() => {
    if (!isOpen) return;
    pokeChrome();
    return clearHideTimer;
  }, [isOpen, pokeChrome, clearHideTimer]);

  const goTo = useCallback(
    (next: number) => {
      if (!hasSlides || onIndexChange === undefined) return;
      const clamped = Math.max(0, Math.min(next, count - 1));
      if (clamped !== index) onIndexChange(clamped);
    },
    [hasSlides, onIndexChange, index, count],
  );

  // The presentation keymap context: owned here, active only while open.
  // Focus is trapped inside the host, so a host-level listener sees every
  // keystroke that matters; Space is prevented from scrolling/activating.
  useEffect(() => {
    if (!isOpen || !hasSlides) return;
    const handler = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          goTo(index + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault();
          goTo(index - 1);
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, hasSlides, index, goTo]);

  if (!isOpen) return null;

  const chromeClass = chromeVisible ? '' : ' presentation-overlay--chrome-hidden';

  const overlay = (
    <div
      ref={hostRef}
      className={`presentation-overlay${chromeClass} ${className}`}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      onPointerMove={pokeChrome}
      onPointerDown={pokeChrome}
      onKeyDown={pokeChrome}
    >
      <div className="presentation-overlay__stage">
        {children}
      </div>

      {hasSlides && (
        <>
          <div
            className="presentation-overlay__zone presentation-overlay__zone--prev"
            aria-hidden="true"
            onClick={() => goTo(index - 1)}
          />
          <div
            className="presentation-overlay__zone presentation-overlay__zone--next"
            aria-hidden="true"
            onClick={() => goTo(index + 1)}
          />
        </>
      )}

      <div className="presentation-overlay__toolbar">
        {hasSlides && (
          <>
            <Button
              icon="mdi mdi-chevron-left"
              aria-label="Previous slide"
              variant="ghost"
              size="sm"
              disabled={index <= 0}
              onClick={() => goTo(index - 1)}
            />
            <span className="presentation-overlay__counter" aria-live="polite">
              {index + 1} / {count}
            </span>
            <Button
              icon="mdi mdi-chevron-right"
              aria-label="Next slide"
              variant="ghost"
              size="sm"
              disabled={index >= count - 1}
              onClick={() => goTo(index + 1)}
            />
            <span className="presentation-overlay__toolbar-divider" aria-hidden="true" />
          </>
        )}
        <Button
          icon="mdi mdi-close"
          aria-label="Exit presentation"
          variant="ghost"
          size="sm"
          onClick={onClose}
        />
      </div>
    </div>
  );

  // Portal to document.body: the stage must cover app chrome unconditionally.
  return createPortal(overlay, document.body);
}
