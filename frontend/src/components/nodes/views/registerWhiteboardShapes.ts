/**
 * Whiteboard Shape Registration
 *
 * Eagerly imports and registers all whiteboard shape path generators.
 */

import { registerShapePathGenerator } from './whiteboardShapeRegistry';

// ==================== Basic Shapes ====================

registerShapePathGenerator({
  type: 'rectangle',
  getPath: (w, h) => `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`,
});

registerShapePathGenerator({
  type: 'ellipse',
  getPath: (w, h) => `M ${w / 2} 0 A ${w / 2} ${h / 2} 0 1 1 ${w / 2} ${h} A ${w / 2} ${h / 2} 0 1 1 ${w / 2} 0 Z`,
});

registerShapePathGenerator({
  type: 'triangle',
  getPath: (w, h) => `M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`,
});

registerShapePathGenerator({
  type: 'triangle-right',
  getPath: (w, h) => `M 0 0 L ${w} ${h} L 0 ${h} Z`,
});

registerShapePathGenerator({
  type: 'hexagon',
  getPath: (w, h) => {
    const inset = w * 0.25;
    return `M ${inset} 0 L ${w - inset} 0 L ${w} ${h / 2} L ${w - inset} ${h} L ${inset} ${h} L 0 ${h / 2} Z`;
  },
});

registerShapePathGenerator({
  type: 'hexagon-pointy',
  getPath: (w, h) => {
    const qi = h * 0.25;
    return `M ${w / 2} 0 L ${w} ${qi} L ${w} ${h - qi} L ${w / 2} ${h} L 0 ${h - qi} L 0 ${qi} Z`;
  },
});

registerShapePathGenerator({
  type: 'star',
  getPath: (w, h) => {
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
  },
});

registerShapePathGenerator({
  type: 'diamond',
  getPath: (w, h) => `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`,
});

// ==================== Arrows ====================

registerShapePathGenerator({
  type: 'arrow-right',
  getPath: (w, h) => `M 0 ${h * 0.25} L ${w * 0.65} ${h * 0.25} L ${w * 0.65} 0 L ${w} ${h / 2} L ${w * 0.65} ${h} L ${w * 0.65} ${h * 0.75} L 0 ${h * 0.75} Z`,
});

registerShapePathGenerator({
  type: 'arrow-left',
  getPath: (w, h) => `M ${w} ${h * 0.25} L ${w * 0.35} ${h * 0.25} L ${w * 0.35} 0 L 0 ${h / 2} L ${w * 0.35} ${h} L ${w * 0.35} ${h * 0.75} L ${w} ${h * 0.75} Z`,
});

registerShapePathGenerator({
  type: 'arrow-up',
  getPath: (w, h) => `M ${w * 0.25} ${h} L ${w * 0.25} ${h * 0.35} L 0 ${h * 0.35} L ${w / 2} 0 L ${w} ${h * 0.35} L ${w * 0.75} ${h * 0.35} L ${w * 0.75} ${h} Z`,
});

registerShapePathGenerator({
  type: 'arrow-down',
  getPath: (w, h) => `M ${w * 0.25} 0 L ${w * 0.25} ${h * 0.65} L 0 ${h * 0.65} L ${w / 2} ${h} L ${w} ${h * 0.65} L ${w * 0.75} ${h * 0.65} L ${w * 0.75} 0 Z`,
});

// ==================== Complex Shapes ====================

registerShapePathGenerator({
  type: 'cylinder',
  getPath: (w, h) => {
    const ry = h * 0.12;
    return `M 0 ${ry} L 0 ${h - ry} A ${w / 2} ${ry} 0 0 0 ${w} ${h - ry} L ${w} ${ry} A ${w / 2} ${ry} 0 0 1 0 ${ry} Z M 0 ${ry} A ${w / 2} ${ry} 0 0 1 ${w} ${ry} A ${w / 2} ${ry} 0 0 1 0 ${ry}`;
  },
});

registerShapePathGenerator({
  type: 'cloud',
  getPath: (w, h) => {
    const cx = w / 2, cy = h / 2;
    const rx = w * 0.35, ry = h * 0.3;
    const br = Math.min(w, h) * 0.18;
    return `M ${cx - rx - br * 0.3} ${cy}
      C ${cx - rx - br} ${cy - br}, ${cx - rx - br} ${cy - br * 1.8}, ${cx - rx * 0.2} ${cy - ry - br * 0.2}
      C ${cx} ${cy - ry - br * 1.2}, ${cx + rx * 0.2} ${cy - ry - br * 0.2}, ${cx + rx + br} ${cy - br}
      C ${cx + rx + br * 1.2} ${cy}, ${cx + rx + br} ${cy + br}, ${cx + rx * 0.5} ${cy + br * 0.8}
      C ${cx} ${cy + br * 1.2}, ${cx - rx * 0.5} ${cy + br * 0.8}, ${cx - rx - br * 0.3} ${cy} Z`;
  },
});

registerShapePathGenerator({
  type: 'parallelogram',
  getPath: (w, h) => {
    const skew = w * 0.2;
    return `M ${skew} 0 L ${w} 0 L ${w - skew} ${h} L 0 ${h} Z`;
  },
});

registerShapePathGenerator({
  type: 'trapezoid',
  getPath: (w, h) => {
    const inset = w * 0.15;
    return `M ${inset} 0 L ${w - inset} 0 L ${w} ${h} L 0 ${h} Z`;
  },
});

registerShapePathGenerator({
  type: 'cross',
  getPath: (w, h) => {
    const t = Math.min(w, h) * 0.25;
    const bx = (w - t) / 2, by = (h - t) / 2;
    return `M ${bx} 0 L ${bx + t} 0 L ${bx + t} ${by} L ${w} ${by} L ${w} ${by + t} L ${bx + t} ${by + t} L ${bx + t} ${h} L ${bx} ${h} L ${bx} ${by + t} L 0 ${by + t} L 0 ${by} L ${bx} ${by} Z`;
  },
});

registerShapePathGenerator({
  type: 'heart',
  getPath: (w, h) => {
    const cx = w / 2;
    const r = Math.min(w, h) * 0.25;
    return `M ${cx} ${h * 0.85}
      C ${cx} ${h * 0.85}, ${cx - r * 1.8} ${h * 0.55}, ${cx - r * 1.8} ${h * 0.35}
      A ${r} ${r} 0 0 1 ${cx} ${h * 0.35}
      A ${r} ${r} 0 0 1 ${cx + r * 1.8} ${h * 0.35}
      C ${cx + r * 1.8} ${h * 0.55}, ${cx} ${h * 0.85}, ${cx} ${h * 0.85} Z`;
  },
});

registerShapePathGenerator({
  type: 'document',
  getPath: (w, h) => {
    const fold = Math.min(w, h) * 0.18;
    return `M 0 0 L ${w - fold} 0 L ${w} ${fold} L ${w} ${h} L 0 ${h} Z M ${w - fold} 0 L ${w - fold} ${fold} L ${w} ${fold}`;
  },
});
