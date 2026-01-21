/**
 * NodeCircle Component
 * 
 * A circle element for representing nodes in graph views.
 * Supports different states (normal, highlighted, dimmed, selected)
 * and glare effects.
 * 
 * NOTE: Moved from core/ - this is a domain-specific graph component
 */
import './NodeCircle.css';

export type NodeCircleState = 'normal' | 'bright' | 'dim' | 'path' | 'current';

export interface NodeCircleProps {
  /** Center X coordinate */
  cx: number;
  /** Center Y coordinate */
  cy: number;
  /** Base radius */
  radius: number;
  /** Node color */
  color?: string;
  /** Visual state */
  state?: NodeCircleState;
  /** Whether the node is hovered */
  hovered?: boolean;
  /** Whether the node is pinned */
  pinned?: boolean;
  /** Whether the node is being dragged */
  dragging?: boolean;
  /** Optional label to display */
  label?: string;
  /** Label font size */
  labelSize?: number;
  /** Label opacity (0-1) */
  labelOpacity?: number;
  /** Additional className */
  className?: string;
  /** Click handler */
  onClick?: (e: React.MouseEvent) => void;
  /** Double click handler */
  onDoubleClick?: (e: React.MouseEvent) => void;
  /** Mouse enter handler */
  onMouseEnter?: (e: React.MouseEvent) => void;
  /** Mouse leave handler */
  onMouseLeave?: (e: React.MouseEvent) => void;
}

/**
 * NodeCircle component for graph node visualization.
 */
export function NodeCircle({
  cx,
  cy,
  radius,
  color = 'var(--color-primary)',
  state = 'normal',
  hovered = false,
  pinned = false,
  dragging = false,
  label,
  labelSize = 11,
  labelOpacity = 1,
  className = '',
  onClick,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
}: NodeCircleProps) {
  // Calculate visual properties based on state
  const getGlareOpacity = (): number => {
    switch (state) {
      case 'bright':
      case 'current':
        return 0.4;
      case 'dim':
        return 0.05;
      case 'path':
        return 0.25;
      default:
        return 0.2;
    }
  };

  const getGlareRadius = (): number => {
    switch (state) {
      case 'bright':
      case 'current':
        return radius * 2.4;
      default:
        return radius * 1.8;
    }
  };

  const getNodeOpacity = (): number => {
    switch (state) {
      case 'dim':
        return 0.4;
      default:
        return 1;
    }
  };

  const glareRadius = hovered ? getGlareRadius() + 4 : getGlareRadius();
  const nodeRadius = hovered ? radius + 2 : radius;
  
  const classes = [
    'node-circle',
    `node-circle--${state}`,
    hovered ? 'node-circle--hovered' : '',
    pinned ? 'node-circle--pinned' : '',
    dragging ? 'node-circle--dragging' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <g
      className={classes}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {/* Glare effect (background glow) */}
      <circle
        cx={cx}
        cy={cy}
        r={glareRadius}
        fill={color}
        opacity={getGlareOpacity()}
        className="node-circle__glare"
      />
      
      {/* Main node circle */}
      <circle
        cx={cx}
        cy={cy}
        r={nodeRadius}
        fill={color}
        opacity={getNodeOpacity()}
        className="node-circle__body"
      />
      
      {/* Pin indicator */}
      {pinned && (
        <circle
          cx={cx}
          cy={cy}
          r={nodeRadius + 3}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeDasharray="3 3"
          opacity={0.6}
          className="node-circle__pin-ring"
        />
      )}
      
      {/* Label */}
      {label && labelOpacity > 0 && (
        <text
          x={cx}
          y={cy + nodeRadius + labelSize + 4}
          fill="var(--text-primary)"
          fontSize={labelSize}
          textAnchor="middle"
          opacity={labelOpacity}
          className="node-circle__label"
        >
          {label}
        </text>
      )}
    </g>
  );
}

/**
 * Helper function to draw a NodeCircle on a canvas context.
 * For use in canvas-based graph views.
 */
export function drawNodeCircle(
  ctx: CanvasRenderingContext2D,
  props: Omit<NodeCircleProps, 'onClick' | 'onDoubleClick' | 'onMouseEnter' | 'onMouseLeave' | 'className'>
): void {
  const {
    cx,
    cy,
    radius,
    color = '#6366f1',
    state = 'normal',
    hovered = false,
    pinned = false,
    label,
    labelSize = 11,
    labelOpacity = 1,
  } = props;

  // Calculate visual properties
  const getGlareOpacity = (): number => {
    switch (state) {
      case 'bright':
      case 'current':
        return 0.4;
      case 'dim':
        return 0.05;
      case 'path':
        return 0.25;
      default:
        return 0.2;
    }
  };

  const getGlareRadius = (): number => {
    switch (state) {
      case 'bright':
      case 'current':
        return radius * 2.4;
      default:
        return radius * 1.8;
    }
  };

  const getNodeOpacity = (): number => {
    switch (state) {
      case 'dim':
        return 0.4;
      default:
        return 1;
    }
  };

  const glareRadius = hovered ? getGlareRadius() + 4 : getGlareRadius();
  const nodeRadius = hovered ? radius + 2 : radius;

  ctx.save();

  // Draw glare
  ctx.beginPath();
  ctx.arc(cx, cy, glareRadius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = getGlareOpacity();
  ctx.fill();

  // Draw main circle
  ctx.beginPath();
  ctx.arc(cx, cy, nodeRadius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = getNodeOpacity();
  ctx.fill();

  // Draw pin ring if pinned
  if (pinned) {
    ctx.beginPath();
    ctx.arc(cx, cy, nodeRadius + 3, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw label
  if (label && labelOpacity > 0) {
    ctx.font = `${labelSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'var(--text-primary)';
    ctx.globalAlpha = labelOpacity;
    ctx.fillText(label, cx, cy + nodeRadius + 4);
  }

  ctx.restore();
}
