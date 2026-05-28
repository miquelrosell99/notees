/**
 * WhiteboardShapeRenderer — Renders shape elements with SVG.
 */
import React from 'react';
import type { WhiteboardShapeElement } from '@/types/whiteboard';

interface Props {
  element: WhiteboardShapeElement;
  isEditing?: boolean;
  onTextChange?: (text: string) => void;
  onBlur?: () => void;
}

function getShapePath(type: WhiteboardShapeElement['shapeType'], w: number, h: number): string {
  switch (type) {
    case 'rectangle':
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
    case 'ellipse':
      return `M ${w / 2} 0 A ${w / 2} ${h / 2} 0 1 1 ${w / 2} ${h} A ${w / 2} ${h / 2} 0 1 1 ${w / 2} 0 Z`;
    case 'triangle':
      return `M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`;
    case 'triangle-right':
      // Right-angle triangle: 90° corner at bottom-left, hypotenuse from top-left to bottom-right
      return `M 0 0 L ${w} ${h} L 0 ${h} Z`;
    case 'hexagon': {
      const inset = w * 0.25;
      return `M ${inset} 0 L ${w - inset} 0 L ${w} ${h / 2} L ${w - inset} ${h} L ${inset} ${h} L 0 ${h / 2} Z`;
    }
    case 'hexagon-pointy': {
      // Pointy-top hexagon: corner at top and bottom
      const qi = h * 0.25;
      return `M ${w / 2} 0 L ${w} ${qi} L ${w} ${h - qi} L ${w / 2} ${h} L 0 ${h - qi} L 0 ${qi} Z`;
    }
    case 'star': {
      const cx = w / 2, cy = h / 2;
      const outerR = Math.min(w, h) / 2;
      const innerR = outerR * 0.4;
      const points: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const angle = (Math.PI / 5) * i - Math.PI / 2;
        points.push(`${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)}`);
      }
      return `M ${points.join(' L ')} Z`;
    }
    case 'arrow-right':
      return `M 0 ${h * 0.25} L ${w * 0.65} ${h * 0.25} L ${w * 0.65} 0 L ${w} ${h / 2} L ${w * 0.65} ${h} L ${w * 0.65} ${h * 0.75} L 0 ${h * 0.75} Z`;
    case 'arrow-left':
      return `M ${w} ${h * 0.25} L ${w * 0.35} ${h * 0.25} L ${w * 0.35} 0 L 0 ${h / 2} L ${w * 0.35} ${h} L ${w * 0.35} ${h * 0.75} L ${w} ${h * 0.75} Z`;
    case 'arrow-up':
      return `M ${w * 0.25} ${h} L ${w * 0.25} ${h * 0.35} L 0 ${h * 0.35} L ${w / 2} 0 L ${w} ${h * 0.35} L ${w * 0.75} ${h * 0.35} L ${w * 0.75} ${h} Z`;
    case 'arrow-down':
      return `M ${w * 0.25} 0 L ${w * 0.25} ${h * 0.65} L 0 ${h * 0.65} L ${w / 2} ${h} L ${w} ${h * 0.65} L ${w * 0.75} ${h * 0.65} L ${w * 0.75} 0 Z`;
    case 'diamond':
      return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
    case 'cylinder': {
      const ry = h * 0.12;
      return `M 0 ${ry} L 0 ${h - ry} A ${w / 2} ${ry} 0 0 0 ${w} ${h - ry} L ${w} ${ry} A ${w / 2} ${ry} 0 0 1 0 ${ry} Z M 0 ${ry} A ${w / 2} ${ry} 0 0 1 ${w} ${ry} A ${w / 2} ${ry} 0 0 1 0 ${ry}`;
    }
    case 'cloud': {
      const cx = w / 2, cy = h / 2;
      const rx = w * 0.35, ry = h * 0.3;
      const br = Math.min(w, h) * 0.18;
      // A cloud made of overlapping circles
      // Union of circles approximated by a single path
      return `M ${cx - rx - br * 0.3} ${cy}
        C ${cx - rx - br} ${cy - br}, ${cx - rx - br} ${cy - br * 1.8}, ${cx - rx * 0.2} ${cy - ry - br * 0.2}
        C ${cx} ${cy - ry - br * 1.2}, ${cx + rx * 0.2} ${cy - ry - br * 0.2}, ${cx + rx + br} ${cy - br}
        C ${cx + rx + br * 1.2} ${cy}, ${cx + rx + br} ${cy + br}, ${cx + rx * 0.5} ${cy + br * 0.8}
        C ${cx} ${cy + br * 1.2}, ${cx - rx * 0.5} ${cy + br * 0.8}, ${cx - rx - br * 0.3} ${cy} Z`;
    }
    case 'parallelogram': {
      const skew = w * 0.2;
      return `M ${skew} 0 L ${w} 0 L ${w - skew} ${h} L 0 ${h} Z`;
    }
    case 'trapezoid': {
      const inset = w * 0.15;
      return `M ${inset} 0 L ${w - inset} 0 L ${w} ${h} L 0 ${h} Z`;
    }
    case 'cross': {
      const t = Math.min(w, h) * 0.25;
      const bx = (w - t) / 2, by = (h - t) / 2;
      return `M ${bx} 0 L ${bx + t} 0 L ${bx + t} ${by} L ${w} ${by} L ${w} ${by + t} L ${bx + t} ${by + t} L ${bx + t} ${h} L ${bx} ${h} L ${bx} ${by + t} L 0 ${by + t} L 0 ${by} L ${bx} ${by} Z`;
    }
    case 'heart': {
      const cx = w / 2;
      const r = Math.min(w, h) * 0.25;
      return `M ${cx} ${h * 0.85}
        C ${cx} ${h * 0.85}, ${cx - r * 1.8} ${h * 0.55}, ${cx - r * 1.8} ${h * 0.35}
        A ${r} ${r} 0 0 1 ${cx} ${h * 0.35}
        A ${r} ${r} 0 0 1 ${cx + r * 1.8} ${h * 0.35}
        C ${cx + r * 1.8} ${h * 0.55}, ${cx} ${h * 0.85}, ${cx} ${h * 0.85} Z`;
    }
    case 'document': {
      const fold = Math.min(w, h) * 0.18;
      return `M 0 0 L ${w - fold} 0 L ${w} ${fold} L ${w} ${h} L 0 ${h} Z M ${w - fold} 0 L ${w - fold} ${fold} L ${w} ${fold}`;
    }
    default:
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  }
}

export { getShapePath };

export const WhiteboardShapeRenderer: React.FC<Props> = ({
  element,
  isEditing,
  onTextChange,
  onBlur,
}) => {
  const { shapeType, fill, stroke, strokeWidth, strokeStyle, borderRadius, text, textColor, fontSize, textAlign, fontWeight } = element;

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
              className="whiteboard-shape__text-input"
              autoFocus
              value={text}
              onChange={(e) => onTextChange?.(e.target.value)}
              onBlur={onBlur}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onBlur?.();
                e.stopPropagation();
              }}
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
