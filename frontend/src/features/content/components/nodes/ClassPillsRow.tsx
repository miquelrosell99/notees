/**
 * ClassPillsRow — Horizontal row of class pills with overflow handling.
 *
 * When pills don't fit, shows the first pill and a "+#" overflow pill.
 * Clicking the overflow pill opens a popup with the full vertical list.
 */

import { useState, useRef, useEffect, useCallback, memo, lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { NodeRef } from './NodeRef';
import { Pill } from '@/components/ui/Pill';

import { useRemoveClass } from '@/features/content';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { isNonRemovableClass } from '@/constants';
import type { Node } from '@/types';
import './ClassPillsRow.css';

// The add-class button reuses the editor's trigger selector. It MUST be loaded
// lazily: TriggerPopup statically imports this feature's barrel
// (@/features/content), so a static import here would close a barrel-level
// import cycle (content → editor → TriggerPopup → content) whose evaluation
// order breaks module initialization (vitest mocks) and risks TDZ hazards in
// the browser bundle. Dynamic import defers evaluation past app init.
const LazyTriggerPopup = lazy(() =>
  import('@/features/editor/editor/plugins/TriggerPopup').then((m) => ({ default: m.TriggerPopup }))
);

interface ClassPillsRowProps {
  classes: Node[];
  nodeUuid: string;
  readOnly?: boolean;
  onAddClass?: (nodeUuid: string, classId: string) => void;
  /** Whether the node's parent has the "card" class (controls cloze class availability). */
  parentIsCard?: boolean;
}

export const ClassPillsRow = memo(function ClassPillsRow({
      classes,
      nodeUuid,
      readOnly = false,
      onAddClass,
      parentIsCard = false }: ClassPillsRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflowCount, setOverflowCount] = useState(0);
  const [showPopup, setShowPopup] = useState(false);
  // Add-class anchor (viewport coords) for the shared TriggerPopup; null = closed.
  const [addAnchor, setAddAnchor] = useState<{ top: number; left: number; caretTop: number } | null>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const removeClass = useRemoveClass();
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  // Popups flip/clamp against the viewport; rendered hidden until positioned.
  const popupPosition = useViewportFlip(overflowButtonRef, showPopup, {
    popupRef,
    popupHeight: 300,
    fixed: true,
  });

  const classIdsKey = classes.map((c) => c.uuid).join(',');

  // Detect overflow using scrollWidth vs clientWidth
  useEffect(() => {
    const el = containerRef.current;
    if (!el || classes.length <= 1) {
      setOverflowCount(0);
      return;
    }

    const checkOverflow = () => {
      const hasOverflow = el.scrollWidth > el.clientWidth + 1;
      if (hasOverflow) {
        // Show first + count of remaining
        setOverflowCount(classes.length - 1);
      } else {
        setOverflowCount(0);
      }
    };

    checkOverflow();
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [classes.length, classIdsKey]);

  const handleOverflowClick = useCallback(() => {
    setShowPopup((prev) => !prev);
  }, []);

  const handleRemove = useCallback(
    (classId: string) => {
      removeClass.mutate({ nodeUuid, classId });
    },
    [nodeUuid, removeClass]
  );

  const handleClosePopup = useCallback(() => {
    setShowPopup(false);
  }, []);

  const appliedClassIds = new Set(classes.map((c) => c.uuid));

  const handleAddClick = useCallback(() => {
    if (addAnchor) {
      setAddAnchor(null);
      return;
    }
    const rect = addButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // TriggerPopup takes viewport coordinates: top = anchor bottom,
    // caretTop = anchor top (it flips/clamps itself via Floating UI).
    setAddAnchor({ top: rect.bottom, left: rect.left, caretTop: rect.top });
  }, [addAnchor]);

  const visibleClasses = overflowCount > 0 ? classes.slice(0, 1) : classes;

  return (
    <>
      <div ref={containerRef} className="class-pills-row">
        {visibleClasses.map((cls) => {
          const canRemove = !readOnly && !isNonRemovableClass(cls.uuid);
          return (
            <NodeRef
              key={cls.uuid}
              node={cls}
              readOnly={readOnly}
              rightIconHoverReveal={true}
              className="class-pills-row__pill"
              onRemove={canRemove ? () => handleRemove(cls.uuid) : undefined}
            />
          );
        })}
        {overflowCount > 0 && (
          <button
            ref={overflowButtonRef}
            type="button"
            className="class-pills-row__overflow-wrapper"
            onClick={handleOverflowClick}
            aria-label={`Show ${overflowCount} more classes`}
          >
            <Pill
              text={`+${overflowCount}`}
              className="class-pills-row__overflow"
            />
          </button>
        )}
        {onAddClass && !readOnly && (
          <Button
            ref={addButtonRef}
            variant="ghost"
            size="xs"
            icon="mdi mdi-plus"
            className="class-pills-row__add hover-reveal"
            onClick={handleAddClick}
            title="Add class"
            aria-label="Add class"
            aria-expanded={addAnchor !== null}
          />
        )}
      </div>

      {showPopup && (
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click; explicit close button provided */}
          <div
            className="class-pills-popup-backdrop"
            onClick={handleClosePopup}
          />
          <div
            ref={popupRef}
            className="class-pills-popup"
            style={{
              position: 'fixed',
              left: popupPosition?.left ?? 0,
              top: popupPosition?.top ?? 0,
              visibility: popupPosition ? 'visible' : 'hidden',
              zIndex: 'var(--z-10000)',
            }}
          >
            <div className="class-pills-popup__header">
              <span>Classes</span>
              <Button
                variant="ghost"
                size="xs"
                icon="mdi mdi-close"
                className="class-pills-popup__close"
                onClick={handleClosePopup}
                aria-label="Close"
              />
            </div>
            <div className="class-pills-popup__list">
              {classes.map((cls) => {
                const canRemove = !readOnly && !isNonRemovableClass(cls.uuid);
                return (
                  <div key={cls.uuid} className="class-pills-popup__item">
                    <NodeRef node={cls} readOnly={true} />
                    {canRemove && (
                      <Button
                        variant="ghost"
                        size="xs"
                        icon="mdi mdi-close"
                        className="class-pills-popup__remove"
                        onClick={() => handleRemove(cls.uuid)}
                        aria-label={`Remove ${cls.name}`}
                        title="Remove"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {addAnchor && (
        <Suspense fallback={null}>
          <LazyTriggerPopup
            type="class"
            position={addAnchor}
            workspaceId={workspaceId}
            parentIsCard={parentIsCard}
            excludeNodeIds={[...appliedClassIds]}
            onSelectNode={(selected) => {
              // No editor context here: both modes assign the class.
              onAddClass?.(nodeUuid, selected.uuid);
              setAddAnchor(null);
            }}
            onClose={() => setAddAnchor(null)}
          />
        </Suspense>
      )}
    </>
  );
});
