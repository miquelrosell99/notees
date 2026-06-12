import { PRESET_COLOR_ENTRIES } from '@/utils/colorPresets';
import type { ColorEntry } from '@/components/ui/ColorButton';
import type { WhiteboardTool } from '@/types/whiteboard';
import type { SelectionButtonOption } from '@/components/ui/SelectionButton';

export const TOOL_GROUPS = [
  {
    label: 'Selection',
    tools: [
      { tool: 'select' as WhiteboardTool, icon: "mdi mdi-cursor-default-outline", label: 'Select', shortcut: 'V' },
    ],
  },
  {
    label: 'Shapes',
    tools: [
      { tool: 'rectangle' as WhiteboardTool, icon: "mdi mdi-rectangle-outline", label: 'Rectangle', shortcut: 'R' },
      { tool: 'ellipse' as WhiteboardTool, icon: "mdi mdi-circle-outline", label: 'Ellipse', shortcut: 'O' },
      { tool: 'triangle' as WhiteboardTool, icon: "mdi mdi-triangle-outline", label: 'Triangle', shortcut: '' },
      { tool: 'hexagon' as WhiteboardTool, icon: "mdi mdi-hexagon-outline", label: 'Hexagon', shortcut: '' },
      { tool: 'star' as WhiteboardTool, icon: "mdi mdi-star-outline", label: 'Star', shortcut: '' },
      { tool: 'diamond' as WhiteboardTool, icon: "mdi mdi-rhombus-outline", label: 'Diamond', shortcut: '' },
      { tool: 'cylinder' as WhiteboardTool, icon: "mdi mdi-database-outline", label: 'Cylinder', shortcut: '' },
      { tool: 'cloud' as WhiteboardTool, icon: "mdi mdi-cloud-outline", label: 'Cloud', shortcut: '' },
      { tool: 'parallelogram' as WhiteboardTool, icon: "mdi mdi-parallelogram", label: 'Parallelogram', shortcut: '' },
      { tool: 'trapezoid' as WhiteboardTool, icon: "mdi mdi-trapezoid", label: 'Trapezoid', shortcut: '' },
      { tool: 'cross' as WhiteboardTool, icon: "mdi mdi-plus-box-outline", label: 'Cross', shortcut: '' },
      { tool: 'heart' as WhiteboardTool, icon: "mdi mdi-heart-outline", label: 'Heart', shortcut: '' },
      { tool: 'document' as WhiteboardTool, icon: "mdi mdi-file-document-outline", label: 'Document', shortcut: '' },
    ],
  },
  {
    label: 'Drawing',
    tools: [
      { tool: 'pen' as WhiteboardTool, icon: "mdi mdi-pencil-outline", label: 'Pen', shortcut: 'P' },
      { tool: 'highlighter' as WhiteboardTool, icon: "mdi mdi-marker", label: 'Highlighter', shortcut: '' },
      { tool: 'eraser' as WhiteboardTool, icon: "mdi mdi-eraser-variant", label: 'Eraser', shortcut: 'E' },
    ],
  },
  {
    label: 'Other',
    tools: [
      { tool: 'text' as WhiteboardTool, icon: "mdi mdi-format-text", label: 'Text', shortcut: 'T' },
      { tool: 'connector' as WhiteboardTool, icon: "mdi mdi-vector-line", label: 'Connector', shortcut: 'L' },
    ],
  },
];

/** Theme-aware color palette stored as CSS variable references */
export const WB_COLOR_VARS: ColorEntry[] = [
  { cssVar: 'var(--color-on-surface)',        label: 'Default' },
  { cssVar: 'var(--color-background)',         label: 'Background' },
  ...PRESET_COLOR_ENTRIES,
];

export const STROKE_WIDTHS = [1, 2, 3, 5, 8, 12];
export const ERASER_WIDTHS = [5, 10, 15, 25, 40];
export const SHAPE_STROKE_WIDTHS = [1, 2, 3, 5, 8];

export const PEN_WIDTH_OPTIONS: SelectionButtonOption[] = STROKE_WIDTHS.map((w) => ({
  value: String(w),
  icon: makeWidthIconPath(w),
  label: `${w}px`,
}));

export const ERASER_WIDTH_OPTIONS: SelectionButtonOption[] = ERASER_WIDTHS.map((w) => ({
  value: String(w),
  icon: makeWidthIconPath(w, 16),
  label: `${w}px`,
}));

export const SHAPE_WIDTH_OPTIONS: SelectionButtonOption[] = SHAPE_STROKE_WIDTHS.map((w) => ({
  value: String(w),
  icon: makeWidthIconPath(w),
  label: `${w}px`,
}));

/**
 * Generate a filled-rectangle SVG path in a 24×24 viewport to visually
 * represent a stroke of the given pixel width.
 */
export function makeWidthIconPath(w: number, maxH = 14): string {
  const h = Math.max(1.5, Math.min(maxH, w * 1.2));
  const y = (24 - h) / 2;
  return `M2,${y.toFixed(1)} L22,${y.toFixed(1)} L22,${(y + h).toFixed(1)} L2,${(y + h).toFixed(1)} Z`;
}

/** Shape-tool options for the SelectionButton in the shapes panel */
export const SHAPE_TOOL_OPTIONS: SelectionButtonOption[] = [
  { value: 'rectangle',     icon: "mdi mdi-rectangle-outline",     label: 'Rectangle (R)' },
  { value: 'ellipse',       icon: "mdi mdi-circle-outline",        label: 'Ellipse (O)'  },
  { value: 'triangle',      icon: "mdi mdi-triangle-outline",      label: 'Triangle'     },
  { value: 'hexagon',       icon: "mdi mdi-hexagon-outline",       label: 'Hexagon'      },
  { value: 'star',          icon: "mdi mdi-star-outline",          label: 'Star'         },
  { value: 'diamond',       icon: "mdi mdi-rhombus-outline",       label: 'Diamond'      },
  { value: 'cylinder',      icon: "mdi mdi-database-outline",      label: 'Cylinder'     },
  { value: 'cloud',         icon: "mdi mdi-cloud-outline",         label: 'Cloud'        },
  { value: 'parallelogram', icon: "mdi mdi-parallelogram",         label: 'Parallelogram' },
  { value: 'trapezoid',     icon: "mdi mdi-trapezoid",             label: 'Trapezoid'    },
  { value: 'cross',         icon: "mdi mdi-plus-box-outline",      label: 'Cross'        },
  { value: 'heart',         icon: "mdi mdi-heart-outline",         label: 'Heart'        },
  { value: 'document',      icon: "mdi mdi-file-document-outline", label: 'Document'     },
  { value: 'line',          icon: "mdi mdi-minus",                 label: 'Line'         },
];

export const STROKE_STYLE_OPTIONS: SelectionButtonOption[] = [
  {
    value: 'solid',
    icon: 'M 2 10 H 22 V 14 H 2 Z',
    label: 'Solid',
  },
  {
    value: 'dashed',
    icon: 'M 2 10 H 8 V 14 H 2 Z M 10 10 H 16 V 14 H 10 Z M 18 10 H 22 V 14 H 18 Z',
    label: 'Dashed',
  },
  {
    value: 'dotted',
    icon: 'M 1 10 H 5 V 14 H 1 Z M 7 10 H 11 V 14 H 7 Z M 13 10 H 17 V 14 H 13 Z M 19 10 H 23 V 14 H 19 Z',
    label: 'Dotted',
  },
];

export function isShapeTool(tool: WhiteboardTool): boolean {
  return ['rectangle', 'ellipse', 'triangle', 'hexagon', 'star', 'line',
          'diamond', 'cylinder', 'cloud', 'parallelogram', 'trapezoid',
          'cross', 'heart', 'document'].includes(tool);
}

export function getShapeIcon(tool: WhiteboardTool): string {
  switch (tool) {
    case 'ellipse': return "mdi mdi-circle-outline";
    case 'triangle': return "mdi mdi-triangle-outline";
    case 'hexagon': return "mdi mdi-hexagon-outline";
    case 'star': return "mdi mdi-star-outline";
    case 'diamond': return "mdi mdi-rhombus-outline";
    case 'cylinder': return "mdi mdi-database-outline";
    case 'cloud': return "mdi mdi-cloud-outline";
    case 'parallelogram': return "mdi mdi-parallelogram";
    case 'trapezoid': return "mdi mdi-trapezoid";
    case 'cross': return "mdi mdi-plus-box-outline";
    case 'heart': return "mdi mdi-heart-outline";
    case 'document': return "mdi mdi-file-document-outline";
    case 'line': return "mdi mdi-minus";
    default: return "mdi mdi-rectangle-outline";
  }
}
