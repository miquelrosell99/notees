/**
 * ClassPillsRow — Horizontal row of class pills with overflow handling.
 *
 * When pills don't fit, shows the first pill and a "+#" overflow pill.
 * Clicking the overflow pill opens a popup with the full vertical list.
 */

import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Button } from '@/components/ui/Button';
import { NodeRef } from './NodeRef';
import { Pill } from '@/components/ui/Pill';

import { useRemoveClass, useClasses } from '@/features/content';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { isNonRemovableClass, SYSTEM_CLASS_UUIDS } from '@/constants';
import type { Node } from '@/types';
import './ClassPillsRow.css';

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
  const [showAddPopup, setShowAddPopup] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const addPopupRef = useRef<HTMLDivElement>(null);
  const removeClass = useRemoveClass();
  const { data: allClasses } = useClasses();

  // Popups flip/clamp against the viewport; rendered hidden until positioned.
  const popupPosition = useViewportFlip(overflowButtonRef, showPopup, {
    popupRef,
    popupHeight: 300,
    fixed: true,
  });
  const addPopupPosition = useViewportFlip(addButtonRef, showAddPopup, {
    popupRef: addPopupRef,
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
  const availableClasses = allClasses?.filter((c) => {
    if (appliedClassIds.has(c.uuid)) return false;
    if (c.uuid === SYSTEM_CLASS_UUIDS.cloze) return parentIsCard;
    return true;
  }) ?? [];

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
        {onAddClass && !readOnly && availableClasses.length > 0 && (
          <Button
            ref={addButtonRef}
            variant="ghost"
            size="xs"
            icon="mdi mdi-plus"
            className="class-pills-row__add hover-reveal"
            onClick={() => setShowAddPopup((prev) => !prev)}
            title="Add class"
            aria-label="Add class"
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

      {showAddPopup && (
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click; explicit close button provided */}
          <div
            className="class-pills-popup-backdrop"
            onClick={() => setShowAddPopup(false)}
          />
          <div
            ref={addPopupRef}
            className="class-pills-popup"
            style={{
              position: 'fixed',
              left: addPopupPosition?.left ?? 0,
              top: addPopupPosition?.top ?? 0,
              visibility: addPopupPosition ? 'visible' : 'hidden',
              zIndex: 'var(--z-10000)',
            }}
          >
            <div className="class-pills-popup__header">
              <span>Add class</span>
              <Button
                variant="ghost"
                size="xs"
                icon="mdi mdi-close"
                className="class-pills-popup__close"
                onClick={() => setShowAddPopup(false)}
                aria-label="Close"
              />
            </div>
            <div className="class-pills-popup__list">
              {availableClasses.map((cls) => (
                <div
                  key={cls.uuid}
                  role="button"
                  tabIndex={0}
                  className="class-pills-popup__item class-pills-popup__item--button"
                  onClick={() => {
                    onAddClass?.(nodeUuid, cls.uuid);
                    setShowAddPopup(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onAddClass?.(nodeUuid, cls.uuid);
                      setShowAddPopup(false);
                    }
                  }}
                  aria-label={`Add class ${cls.name}`}
                >
                  <NodeRef node={cls} readOnly={true} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
});
