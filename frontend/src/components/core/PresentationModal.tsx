/**
 * PresentationModal Component
 *
 * Floating modal for presenting a node's children as slides.
 * - Each child node is a slide
 * - Left/Right arrow keys or on-screen buttons navigate between slides
 * - Each slide shows the child node's title and a read-only BlockList
 *   displaying its nested children up to the linked-references collapse level
 * - Fullscreen toggle button in the top-right corner
 * - Escape closes the modal
 */
import { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNode } from '@/hooks';
import { useSettingsStore } from '@/stores';
import { usePresentationStore } from '@/stores/presentationStore';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { BlockList } from '@/components/blocks/BlockList';
import { Button } from './Button';
import type { Node } from '@/types';
import './PresentationModal.css';

function getSlideTitle(node: Node): string {
  return nodeNameToText(node.name) || 'Untitled';
}

export function PresentationModal() {
  const { isOpen, nodeId, closePresentation } = usePresentationStore();
  const { data: node } = useNode(nodeId, { include_children: true });
  const linkedRefsCollapseLevel = useSettingsStore((state) => state.linkedRefsCollapseLevel);
  const containerRef = useRef<HTMLDivElement>(null);

  const slides = useMemo(() => {
    if (!node?.children) return [];
    return node.children.filter((child) => !child.is_deleted && !child.is_comment);
  }, [node]);

  const [currentIndex, setCurrentIndex] = useState(0);

  const goToPrev = useCallback(() => {
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const goToNext = useCallback(() => {
    setCurrentIndex((prev) => Math.min(prev + 1, Math.max(slides.length - 1, 0)));
  }, [slides.length]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePresentation();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToNext();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closePresentation, goToPrev, goToNext]);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  if (!isOpen) return null;

  const slideNode = slides[currentIndex];

  const modalContent = (
    <div ref={containerRef} className="presentation-modal-backdrop">
      {/* Top-right actions */}
      <div className="presentation-modal-actions">
        <Button
          icon={"mdi mdi-fullscreen"}
          iconOnly
          onClick={toggleFullscreen}
          size="md"
          variant="ghost"
          title="Toggle fullscreen"
        />
        <Button
          icon={"mdi mdi-close"}
          iconOnly
          onClick={closePresentation}
          size="md"
          variant="ghost"
          title="Close (Esc)"
        />
      </div>

      {/* Navigation buttons */}
      {slides.length > 1 && (
        <>
          <div className="presentation-modal-nav presentation-modal-nav--prev">
            <Button
              icon={"mdi mdi-chevron-left"}
              iconOnly
              onClick={goToPrev}
              size="lg"
              variant="ghost"
              disabled={currentIndex === 0}
              title="Previous slide"
            />
          </div>
          <div className="presentation-modal-nav presentation-modal-nav--next">
            <Button
              icon={"mdi mdi-chevron-right"}
              iconOnly
              onClick={goToNext}
              size="lg"
              variant="ghost"
              disabled={currentIndex === slides.length - 1}
              title="Next slide"
            />
          </div>
        </>
      )}

      {/* Slide content */}
      {slides.length === 0 ? (
        <div className="presentation-modal-empty">No slides to present</div>
      ) : slideNode ? (
        <div className="presentation-modal-slide">
          <div className="presentation-modal-slide-title">
            {getSlideTitle(slideNode)}
          </div>
          <div className="presentation-modal-slide-content">
            {slideNode.children && slideNode.children.length > 0 ? (
              <BlockList
                nodes={slideNode.children ?? []}
                readOnly={true}
                maxDepth={linkedRefsCollapseLevel}
                pageUuid={slideNode.uuid}
              />
            ) : (
              <div className="presentation-modal-no-children">No nested content</div>
            )}
          </div>
        </div>
      ) : null}

      {/* Slide counter */}
      {slides.length > 0 && (
        <div className="presentation-modal-counter">
          {currentIndex + 1} / {slides.length}
        </div>
      )}
    </div>
  );

  return createPortal(modalContent, document.body);
}
