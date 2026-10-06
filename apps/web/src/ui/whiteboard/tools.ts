/**
 * Whiteboard tool palette — the full toolset
 * (select/move, card, sticky note, rect/ellipse/line/arrow, the
 * pen/highlighter/eraser group, freehand stroke, text, connector). Tools are
 * pure interaction modes: they decide what a surface pointer gesture means
 * (place, draw, marquee, erase) and never carry state of their own.
 * Geometry writes still ride the token layout through WhiteboardCanvas (one
 * coalesced `object.update` per gesture).
 *
 * Gestures:
 *  - "click"  — pointer-down places something (card/sticky/text).
 *  - "drag"   — pointer-down starts a rubber-band draw (shapes/connector/stroke).
 *  - "marquee"— the select tool: background drag box-selects.
 *
 * Draw/place tools are one-shot: a completed gesture (or Esc) returns the
 * palette to select, so consecutive placements don't need re-arming.
 */

export type WhiteboardTool =
  | "select"
  | "card"
  | "sticky"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "stroke"
  | "highlighter"
  | "eraser"
  | "text"
  | "connector";

export type WhiteboardToolGesture = "click" | "drag" | "marquee";

export interface WhiteboardToolDef {
  id: WhiteboardTool;
  /** Accessible name (toolbar button aria-label). */
  label: string;
  /** Short visible label on the palette button. */
  shortLabel: string;
  /** MDI icon name for the palette button. */
  icon: string;
  gesture: WhiteboardToolGesture;
  /** Surface cursor while the tool is armed. */
  cursor: string;
}

export const WHITEBOARD_TOOLS: readonly WhiteboardToolDef[] = [
  { id: "select", label: "Select / move", shortLabel: "Select", icon: "cursor-default-outline", gesture: "marquee", cursor: "default" },
  { id: "card", label: "Add card", shortLabel: "Card", icon: "card-text-outline", gesture: "click", cursor: "crosshair" },
  { id: "sticky", label: "Add sticky note", shortLabel: "Sticky", icon: "note-outline", gesture: "click", cursor: "crosshair" },
  { id: "rect", label: "Add rectangle", shortLabel: "Rect", icon: "rectangle-outline", gesture: "drag", cursor: "crosshair" },
  { id: "ellipse", label: "Add ellipse", shortLabel: "Ellipse", icon: "circle-outline", gesture: "drag", cursor: "crosshair" },
  { id: "line", label: "Add line", shortLabel: "Line", icon: "minus", gesture: "drag", cursor: "crosshair" },
  { id: "arrow", label: "Add arrow", shortLabel: "Arrow", icon: "arrow-top-right", gesture: "drag", cursor: "crosshair" },
  // The pen/highlighter/eraser group:
  // pen = freehand stroke; highlighter = freehand stroke with the layout
  // schema's `highlight` flag (translucent wide marker); eraser = drag to
  // remove strokes/shapes under the pointer. Pen/highlighter are one-shot
  // (return to select after a stroke); the eraser stays armed until Esc.
  { id: "stroke", label: "Draw stroke", shortLabel: "Pen", icon: "pencil-outline", gesture: "drag", cursor: "crosshair" },
  { id: "highlighter", label: "Highlight", shortLabel: "Marker", icon: "marker", gesture: "drag", cursor: "crosshair" },
  { id: "eraser", label: "Eraser", shortLabel: "Eraser", icon: "eraser", gesture: "drag", cursor: "cell" },
  { id: "text", label: "Add text", shortLabel: "Text", icon: "format-text", gesture: "click", cursor: "text" },
  { id: "connector", label: "Add connector", shortLabel: "Connect", icon: "vector-line", gesture: "drag", cursor: "crosshair" },
] as const;

export function toolDef(id: WhiteboardTool): WhiteboardToolDef {
  return WHITEBOARD_TOOLS.find((t) => t.id === id)!;
}

/** Shape-kind tools create one of the layout shape kinds when dragged. */
export const TOOL_SHAPE_KIND: Partial<Record<WhiteboardTool, "rect" | "ellipse" | "line" | "arrow">> = {
  rect: "rect",
  ellipse: "ellipse",
  line: "line",
  arrow: "arrow",
};
