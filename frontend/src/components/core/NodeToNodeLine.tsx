/**
 * NodeToNodeLine Component
 * 
 * A line component for connecting nodes in graph views.
 * Supports different line styles (solid, dotted, dashed) and arrows.
 */
import './NodeToNodeLine.css';

export type LineStyle = 'solid' | 'dotted' | 'dashed';
export type ArrowDirection = 'none' | 'start' | 'end' | 'both';

export interface NodeToNodeLineProps {
  /** Starting X coordinate */
  x1: number;
  /** Starting Y coordinate */
  y1: number;
  /** Ending X coordinate */
  x2: number;
  /** Ending Y coordinate */
  y2: number;
  /** Line style */
  style?: LineStyle;
  /** Arrow direction */
  arrow?: ArrowDirection;
  /** Line color */
  color?: string;
  /** Line width/thickness */
  width?: number;
  /** Arrow size */
  arrowSize?: number;
  /** Opacity */
  opacity?: number;
  /** Additional className */
  className?: string;
  /** Whether the line is highlighted */
  highlighted?: boolean;
  /** Whether the line is dimmed */
  dimmed?: boolean;
}

/**
 * Calculate arrow points for an arrowhead
 */
function getArrowPoints(
  x: number,
  y: number,
  angle: number,
  size: number
): string {
  const x1 = x - size * Math.cos(angle - Math.PI / 6);
  const y1 = y - size * Math.sin(angle - Math.PI / 6);
  const x2 = x - size * Math.cos(angle + Math.PI / 6);
  const y2 = y - size * Math.sin(angle + Math.PI / 6);
  
  return `${x},${y} ${x1},${y1} ${x2},${y2}`;
}

/**
 * NodeToNodeLine component for graph connections.
 */
export function NodeToNodeLine({
  x1,
  y1,
  x2,
  y2,
  style = 'solid',
  arrow = 'none',
  color = 'var(--color-outline)',
  width = 1,
  arrowSize = 8,
  opacity = 1,
  className = '',
  highlighted = false,
  dimmed = false,
}: NodeToNodeLineProps) {
  // Calculate angle between points
  const angle = Math.atan2(y2 - y1, x2 - x1);
  
  // Adjust endpoints if arrows are present to not overlap with arrow
  const adjustedX1 = arrow === 'start' || arrow === 'both' 
    ? x1 + (arrowSize * 0.5) * Math.cos(angle)
    : x1;
  const adjustedY1 = arrow === 'start' || arrow === 'both'
    ? y1 + (arrowSize * 0.5) * Math.sin(angle)
    : y1;
  const adjustedX2 = arrow === 'end' || arrow === 'both'
    ? x2 - (arrowSize * 0.5) * Math.cos(angle)
    : x2;
  const adjustedY2 = arrow === 'end' || arrow === 'both'
    ? y2 - (arrowSize * 0.5) * Math.sin(angle)
    : y2;

  // Determine stroke-dasharray based on style
  const getDashArray = (): string | undefined => {
    switch (style) {
      case 'dotted':
        return `${width * 2} ${width * 3}`;
      case 'dashed':
        return `${width * 6} ${width * 4}`;
      default:
        return undefined;
    }
  };

  const finalOpacity = dimmed ? opacity * 0.3 : highlighted ? opacity : opacity;
  const finalWidth = highlighted ? width * 1.5 : width;
  const finalColor = highlighted ? 'var(--color-primary)' : color;

  const classes = [
    'node-to-node-line',
    `node-to-node-line--${style}`,
    highlighted ? 'node-to-node-line--highlighted' : '',
    dimmed ? 'node-to-node-line--dimmed' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <g className={classes}>
      {/* Main line */}
      <line
        x1={adjustedX1}
        y1={adjustedY1}
        x2={adjustedX2}
        y2={adjustedY2}
        stroke={finalColor}
        strokeWidth={finalWidth}
        strokeDasharray={getDashArray()}
        opacity={finalOpacity}
        strokeLinecap="round"
      />
      
      {/* Start arrow */}
      {(arrow === 'start' || arrow === 'both') && (
        <polygon
          points={getArrowPoints(x1, y1, angle + Math.PI, arrowSize)}
          fill={finalColor}
          opacity={finalOpacity}
        />
      )}
      
      {/* End arrow */}
      {(arrow === 'end' || arrow === 'both') && (
        <polygon
          points={getArrowPoints(x2, y2, angle, arrowSize)}
          fill={finalColor}
          opacity={finalOpacity}
        />
      )}
    </g>
  );
}

/**
 * Helper function to render NodeToNodeLine on a canvas context.
 * For use in canvas-based graph views.
 */
export function drawNodeToNodeLine(
  ctx: CanvasRenderingContext2D,
  props: NodeToNodeLineProps
): void {
  const {
    x1,
    y1,
    x2,
    y2,
    style = 'solid',
    arrow = 'none',
    color = '#666',
    width = 1,
    arrowSize = 8,
    opacity = 1,
    highlighted = false,
    dimmed = false,
  } = props;

  const finalOpacity = dimmed ? opacity * 0.3 : highlighted ? opacity : opacity;
  const finalWidth = highlighted ? width * 1.5 : width;
  
  ctx.save();
  ctx.globalAlpha = finalOpacity;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = finalWidth;
  ctx.lineCap = 'round';

  // Set dash pattern based on style
  switch (style) {
    case 'dotted':
      ctx.setLineDash([width * 2, width * 3]);
      break;
    case 'dashed':
      ctx.setLineDash([width * 6, width * 4]);
      break;
    default:
      ctx.setLineDash([]);
  }

  // Calculate angle
  const angle = Math.atan2(y2 - y1, x2 - x1);

  // Draw line
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Reset dash for arrows
  ctx.setLineDash([]);

  // Draw arrows
  if (arrow === 'start' || arrow === 'both') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(
      x1 - arrowSize * Math.cos(angle - Math.PI / 6),
      y1 - arrowSize * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x1 - arrowSize * Math.cos(angle + Math.PI / 6),
      y1 - arrowSize * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  if (arrow === 'end' || arrow === 'both') {
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - arrowSize * Math.cos(angle - Math.PI / 6),
      y2 - arrowSize * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - arrowSize * Math.cos(angle + Math.PI / 6),
      y2 - arrowSize * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}
