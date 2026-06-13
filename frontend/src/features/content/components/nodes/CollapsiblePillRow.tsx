/**
 * CollapsiblePillRow — Horizontal row of pills that collapses when space is tight.
 *
 * Detects overflow using ResizeObserver and shows as many pills as fit,
 * followed by a "+X" overflow pill. Clicking the overflow pill opens a
 * popup with the full list.
 *
 * Usage:
 *   <CollapsiblePillRow
 *     items={classNodes}
 *     getKey={(n) => n.id}
 *     renderPill={(n) => <NodeRef node={n} onRemove={...} />}
 *     renderAddButton={() => <Button icon="mdi-plus" ... />}
 *     popupTitle="Classes"
 *   />
 */
import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import './CollapsiblePillRow.css';

interface CollapsiblePillRowProps<T> {
  items: T[];
  getKey: (item: T) => string | number;
  renderPill: (item: T) => ReactNode;
  renderAddButton?: () => ReactNode;
  popupTitle?: string;
  className?: string;
}

export function CollapsiblePillRow<T>({
  items,
  getKey,
  renderPill,
  renderAddButton,
  popupTitle,
  className = '',
}: CollapsiblePillRowProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [showPopup, setShowPopup] = useState(false);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const pendingRef = useRef(false);

  const itemsKey = items.map(getKey).join(',');

  // Reset visible count when items change
  useEffect(() => {
    setVisibleCount(items.length);
  }, [itemsKey, items.length]);

  // Detect overflow and reduce visible count iteratively
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      if (pendingRef.current) return;
      pendingRef.current = true;

      requestAnimationFrame(() => {
        pendingRef.current = false;
        if (!el) return;

        const hasOverflow = el.scrollWidth > el.clientWidth + 1;
        if (hasOverflow && visibleCount > 1) {
          setVisibleCount((c) => c - 1);
        }
      });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [visibleCount, items.length]);

  const handleOverflowClick = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopupPos({ x: rect.left, y: rect.bottom + 4 });
    setShowPopup((prev) => !prev);
  }, []);

  const handleClosePopup = useCallback(() => {
    setShowPopup(false);
  }, []);

  const hasOverflow = visibleCount < items.length;
  const visibleItems = hasOverflow ? items.slice(0, visibleCount) : items;
  const overflowCount = items.length - visibleCount;

  return (
    <>
      <div ref={containerRef} className={`collapsible-pill-row ${className}`}>
        {visibleItems.map((item) => (
          <div key={getKey(item)} className="collapsible-pill-row__pill">
            {renderPill(item)}
          </div>
        ))}
        {hasOverflow && (
          <button
            type="button"
            className="collapsible-pill-row__overflow-wrapper"
            onClick={handleOverflowClick}
            aria-label={`Show ${overflowCount} more`}
          >
            <Pill text={`+${overflowCount}`} className="collapsible-pill-row__overflow" />
          </button>
        )}
        {renderAddButton?.()}
      </div>

      {showPopup && (
        <>
          <div className="collapsible-pill-row__backdrop" onClick={handleClosePopup} role="presentation" />
          <div
            className="collapsible-pill-row__popup"
            style={{
              position: 'fixed',
              left: popupPos.x,
              top: popupPos.y,
              zIndex: 'var(--z-10000)',
            }}
          >
            {popupTitle && (
              <div className="collapsible-pill-row__popup-header">
                <span>{popupTitle}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  icon="mdi mdi-close"
                  className="collapsible-pill-row__popup-close"
                  onClick={handleClosePopup}
                  aria-label="Close"
                />
              </div>
            )}
            <div className="collapsible-pill-row__popup-list">
              {items.map((item) => (
                <div key={getKey(item)} className="collapsible-pill-row__popup-item">
                  {renderPill(item)}
                </div>
              ))}
            </div>
            {renderAddButton && (
              <div className="collapsible-pill-row__popup-footer">
                {renderAddButton()}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
