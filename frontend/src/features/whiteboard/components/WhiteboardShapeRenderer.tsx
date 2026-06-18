/**
 * WhiteboardShapeRenderer — Renders shape elements with SVG.
 */
import React, { useRef, useEffect } from 'react';
import type { WhiteboardShapeElement } from '@/features/whiteboard/types/whiteboard';
import { getShapePath } from './whiteboardShapeUtils';

interface Props {
  element: WhiteboardShapeElement;
  isEditing?: boolean;
  onTextChange?: (text: string) => void;
  onBlur?: () => void;
}

export const WhiteboardShapeRenderer: React.FC<Props> = ({
  element,
  isEditing,
  onTextChange,
  onBlur,
}) => {
  const { shapeType, fill, stroke, strokeWidth, strokeStyle, borderRadius, text, textColor, fontSize, textAlign, fontWeight } = element;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus();
    }
  }, [isEditing]);

  const ssClass = strokeStyle === 'dashed' ? 'wb-ss-dashed' : strokeStyle === 'dotted' ? 'wb-ss-dotted' : '';

  return (
    <div className="whiteboard-shape">
      <svg viewBox={`0 0 ${element.width} ${element.height}`} preserveAspectRatio="none">
        {shapeType === 'rectangle' ? (
          <rect
            x={strokeWidth / 2}
            y={strokeWidth / 2}
            width={element.width - strokeWidth}
            height={element.height - strokeWidth}
            rx={borderRadius}
            ry={borderRadius}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
            className={ssClass || undefined}
          />
        ) : shapeType === 'ellipse' ? (
          <ellipse
            cx={element.width / 2}
            cy={element.height / 2}
            rx={(element.width - strokeWidth) / 2}
            ry={(element.height - strokeWidth) / 2}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
            className={ssClass || undefined}
          />
        ) : (
          <path
            d={getShapePath(shapeType, element.width, element.height)}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
            className={ssClass || undefined}
            strokeLinejoin="round"
          />
        )}
      </svg>
      {(text || isEditing) && (
        <div
          className="whiteboard-shape__text"
          style={{
            color: textColor,
            fontSize,
            textAlign,
            fontWeight,
          }}
        >
          {isEditing ? (
            <textarea
              ref={textareaRef}
              className="whiteboard-shape__text-input"
              value={text}
              onChange={(e) => onTextChange?.(e.target.value)}
              onBlur={onBlur}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onBlur?.();
                e.stopPropagation();
              }}
              aria-label="Shape text"
              style={{ color: textColor, fontSize, textAlign, fontWeight }}
            />
          ) : (
            <span>{text}</span>
          )}
        </div>
      )}
    </div>
  );
};
