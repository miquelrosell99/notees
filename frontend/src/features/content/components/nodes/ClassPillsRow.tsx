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

import { useRemoveClass, useClasses } from '@/hooks';
import { isNonRemovableClass } from '@/constants';
import type { Node } from '@/types';
import './ClassPillsRow.css';

interface ClassPillsRowProps {
  classes: Node[];
  nodeId: number;
  readOnly?: boolean;
  onAddClass?: (nodeId: number, classId: number) => void;
}

export const ClassPillsRow = memo(function ClassPillsRow({
  classes,
  nodeId,
  readOnly = false,
  onAddClass,
}: ClassPillsRowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflowCount, setOverflowCount] = useState(0);
  const [showPopup, setShowPopup] = useState(false);
  const [showAddPopup, setShowAddPopup] = useState(false);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const removeClass = useRemoveClass();
  const { data: allClasses } = useClasses();

  const classIdsKey = classes.map((c) => c.id).join(',');

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

  const handleOverflowClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPopupPos({ x: rect.left, y: rect.bottom + 4 });
      setShowPopup(true);
    },
    []
  );

  const handleRemove = useCallback(
    (classId: number) => {
      removeClass.mutate({ nodeId, classId });
    },
    [nodeId, removeClass]
  );

  const handleClosePopup = useCallback(() => {
    setShowPopup(false);
  }, []);

  const appliedClassIds = new Set(classes.map((c) => c.id));
  const availableClasses = allClasses?.filter((c) => !appliedClassIds.has(c.id)) ?? [];

  const visibleClasses = overflowCount > 0 ? classes.slice(0, 1) : classes;

  return (
    <>
      <div ref={containerRef} className="class-pills-row">
        {visibleClasses.map((cls) => (
          <NodeRef
            key={cls.id}
            node={cls}
            readOnly={true}
            className="class-pills-row__pill"
          />
        ))}
        {overflowCount > 0 && (
          <span role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }} className="class-pills-row__overflow-wrapper" onClick={handleOverflowClick}>
            <Pill
              text={`+${overflowCount}`}
              className="class-pills-row__overflow"
            />
          </span>
        )}
        {onAddClass && !readOnly && availableClasses.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            icon="mdi mdi-plus"
            className="class-pills-row__add"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setPopupPos({ x: rect.left, y: rect.bottom + 4 });
              setShowAddPopup(true);
            }}
            title="Add class"
            aria-label="Add class"
          />
        )}
      </div>

      {showPopup && (
        <>
          <div className="class-pills-popup-backdrop" onClick={handleClosePopup} />
          <div
            className="class-pills-popup"
            style={{
              position: 'fixed',
              left: popupPos.x,
              top: popupPos.y,
              zIndex: 10000,
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
                  <div key={cls.id} className="class-pills-popup__item">
                    <NodeRef node={cls} readOnly={true} />
                    {canRemove && (
                      <Button
                        variant="ghost"
                        size="xs"
                        icon="mdi mdi-close"
                        className="class-pills-popup__remove"
                        onClick={() => handleRemove(cls.id)}
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
          <div className="class-pills-popup-backdrop" onClick={() => setShowAddPopup(false)} />
          <div
            className="class-pills-popup"
            style={{
              position: 'fixed',
              left: popupPos.x,
              top: popupPos.y,
              zIndex: 10000,
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
                <button
                  key={cls.id}
                  className="class-pills-popup__item class-pills-popup__item--button"
                  onClick={() => {
                    onAddClass?.(nodeId, cls.id);
                    setShowAddPopup(false);
                  }}
                >
                  <NodeRef node={cls} readOnly={true} />
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
});
