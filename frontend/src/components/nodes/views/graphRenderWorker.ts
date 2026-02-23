/**
 * Graph Render Worker
 * 
 * OffscreenCanvas rendering worker for the graph view.
 * Receives packed node positions + metadata from the main thread each render tick,
 * and draws to an OffscreenCanvas transferred during init.
 * 
 * This moves all canvas draw calls off the main thread, eliminating jank
 * from the 8000+ arc/stroke calls needed at 4k nodes.
 * 
 * Physics simulation stays on the main thread (useNodePhysics.ts).
 */

import type {
  MainToWorkerMessage,
  FrameMessage,
  NodeMetadataMessage,
  StyleMessage,
} from './graphWorkerProtocol';
import {
  decodeGlare,
} from './graphWorkerProtocol';
import {
  NODE_RADIUS_BASE,
  NODE_RADIUS_MIN,
  NODE_RADIUS_MAX,
  NODE_RADIUS_MASS_SCALE,
  NODE_RADIUS_CONN_SCALE,
  NODE_HOVER_RADIUS_EXTRA,
  GLARE_SCALE_NORMAL,
  GLARE_SCALE_BRIGHT,
  GLARE_SCALE_CURRENT,
  GLARE_OPACITY_NORMAL,
  GLARE_OPACITY_BRIGHT,
  GLARE_OPACITY_DIM,
  LABEL_FADE_ZOOM_MIN,
  LABEL_FADE_ZOOM_MAX,
  LINE_DASH_NONE,
  LINE_DASH_DOTTED,
  getLODLevel,
  type GlareState,
  type NodeSizeMode,
  type LinkDirection,
  type LODLevel,
} from './viewTypes';

// ==================== State ====================

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let dpr = 1;
let width = 800;
let height = 600;

// Cached node metadata (sent once, updated when topology changes)
let nodeIds: number[] = [];
let nodeUuids: string[] = [];
let displayNames: string[] = [];
let connectionCounts: number[] = [];
let inLinkCounts: number[] = [];
let outLinkCounts: number[] = [];
let masses: number[] = [];
let contentSizes: number[] = [];
let nodeTypeIds: number[][] = [];
let nodeColors: (string | null)[] = [];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _isClassNodes: boolean[] = [];
let treeRadii: (number | undefined)[] = [];

// Style
let classColorMap = new Map<number, string>(); // classId → color
let textColor = '#111111';
let accentColor = '#404040';
let dimColor = '#555555';
let outlineColor = '#a3a3a3';
let warningColor = '#d97706';

// ==================== Hex→RGBA cache ====================

const hexCache = new Map<string, string>();
function hexToRgba(hex: string, alpha: number): string {
  const a = Math.round(alpha * 100) / 100;
  const key = hex + a;
  let result = hexCache.get(key);
  if (result !== undefined) return result;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  result = `rgba(${r}, ${g}, ${b}, ${a})`;
  if (hexCache.size > 2000) hexCache.clear();
  hexCache.set(key, result);
  return result;
}

// ==================== Node helpers ====================

function getNodeRadius(
  index: number,
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  maxContentSize: number,
  linkDirection: LinkDirection,
): number {
  if (nodeSizeMode === 'uniform') return NODE_RADIUS_BASE;
  if (nodeSizeMode === 'connections') {
    const count = linkDirection === 'in' ? inLinkCounts[index]
      : linkDirection === 'out' ? outLinkCounts[index]
      : connectionCounts[index];
    const ratio = maxConnections > 0 ? count / maxConnections : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
  }
  if (nodeSizeMode === 'mass') {
    const mass = masses[index];
    const ratio = maxMass > 1 ? (mass - 1) / (maxMass - 1) : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_MASS_SCALE);
  }
  if (nodeSizeMode === 'content') {
    const count = contentSizes[index];
    const ratio = maxContentSize > 0 ? count / maxContentSize : 0;
    return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.pow(ratio, NODE_RADIUS_CONN_SCALE);
  }
  return NODE_RADIUS_BASE;
}

function getGlareRadius(
  index: number,
  nodeSizeMode: NodeSizeMode,
  maxConnections: number,
  maxMass: number,
  maxContentSize: number,
  linkDirection: LinkDirection,
): number {
  return getNodeRadius(index, nodeSizeMode, maxConnections, maxMass, maxContentSize, linkDirection) * GLARE_SCALE_NORMAL;
}

function getNodeColor(index: number): string {
  const colorOverride = nodeColors[index];
  if (colorOverride) return colorOverride;
  const types = nodeTypeIds[index];
  if (types) {
    for (const classId of types) {
      const cc = classColorMap.get(classId);
      if (cc) return cc;
    }
  }
  return accentColor;
}

// ==================== Pair key (for link dedup) ====================

function pairKey(a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * 1000000 + hi;
}

function linkTypeId(type: number): number {
  // type byte: 0=parent, 1=reference, 2=property-reference, 3=class, 4=extends
  return type;
}

// ==================== Render ====================

function renderFrame(msg: FrameMessage): void {
  if (!ctx || !canvas) return;

  const w = width;
  const h = height;
  const tx = msg.transformX;
  const ty = msg.transformY;
  const scale = msg.transformScale;
  const nc = msg.nodeCount;
  const lc = msg.linkCount;
  const positions = msg.positionBuffer;
  const states = msg.stateBuffer;
  const links = msg.linkBuffer;
  const linkTypes = msg.linkTypeBuffer;
  const maxConn = msg.maxConnections;
  const maxMass = msg.maxMass;
  const maxCS = msg.maxContentSize;
  const nsm = msg.nodeSizeMode;
  const ld = msg.linkDirection;
  const dragIdx = msg.dragNodeIndex;
  const dragLift = msg.dragLiftProgress;
  const viewMode = msg.viewMode;

  // LOD
  const lod: LODLevel = getLODLevel(nc, scale);

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(scale, scale);

  // Viewport bounds in world coordinates
  const invScale = 1 / scale;
  const vpLeft = -tx * invScale;
  const vpTop = -ty * invScale;
  const vpRight = vpLeft + w * invScale;
  const vpBottom = vpTop + h * invScale;
  const vpMargin = 40 * invScale;
  const vpL = vpLeft - vpMargin;
  const vpT = vpTop - vpMargin;
  const vpR = vpRight + vpMargin;
  const vpB = vpBottom + vpMargin;

  // ==================== Draw Links ====================

  const drawnLinks = new Set<number>();

  if (lod === 1) {
    // LOD 1: batch all links as thin hairlines
    ctx.beginPath();
    ctx.strokeStyle = hexToRgba(outlineColor, 0.2);
    ctx.lineWidth = 0.5;
    ctx.setLineDash(LINE_DASH_NONE);
    for (let i = 0; i < lc; i++) {
      const si = links[i * 2];
      const ti = links[i * 2 + 1];
      const sx = positions[si * 2], sy = positions[si * 2 + 1];
      const ex = positions[ti * 2], ey = positions[ti * 2 + 1];
      const minX = sx < ex ? sx : ex, maxX = sx > ex ? sx : ex;
      const minY = sy < ey ? sy : ey, maxY = sy > ey ? sy : ey;
      if (maxX < vpL || minX > vpR || maxY < vpT || minY > vpB) continue;
      const key = pairKey(nodeIds[si], nodeIds[ti]) * 10 + linkTypeId(linkTypes[i]);
      if (drawnLinks.has(key)) continue;
      drawnLinks.add(key);
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
    }
    ctx.stroke();
  } else {
    // LOD 0: Full detail links
    // Build direction map
    const linkDirs = new Map<number, number>();
    for (let i = 0; i < lc; i++) {
      const si = links[i * 2];
      const ti = links[i * 2 + 1];
      const key = pairKey(nodeIds[si], nodeIds[ti]);
      const prev = linkDirs.get(key) || 0;
      if (nodeIds[si] < nodeIds[ti]) {
        linkDirs.set(key, prev | 1);
      } else {
        linkDirs.set(key, prev | 2);
      }
    }

    for (let i = 0; i < lc; i++) {
      const si = links[i * 2];
      const ti = links[i * 2 + 1];
      const sx = positions[si * 2], sy = positions[si * 2 + 1];
      const ex = positions[ti * 2], ey = positions[ti * 2 + 1];
      const minX = sx < ex ? sx : ex, maxX = sx > ex ? sx : ex;
      const minY = sy < ey ? sy : ey, maxY = sy > ey ? sy : ey;
      if (maxX < vpL || minX > vpR || maxY < vpT || minY > vpB) continue;
      
      const lt = linkTypes[i];
      const key = pairKey(nodeIds[si], nodeIds[ti]) * 10 + linkTypeId(lt);
      if (drawnLinks.has(key)) continue;
      drawnLinks.add(key);

      const isParent = lt === 0; // parent
      const isClass = lt === 3;
      const isExtends = lt === 4;
      const renderAsParent = isParent || isExtends;
      const dirBits = linkDirs.get(pairKey(nodeIds[si], nodeIds[ti])) || 0;
      const hasFwd = !!(dirBits & 1);
      const hasRev = !!(dirBits & 2);

      ctx.beginPath();
      ctx.strokeStyle = hexToRgba(outlineColor, 0.4);
      ctx.lineWidth = 1.5;
      ctx.setLineDash((renderAsParent || isClass) ? LINE_DASH_NONE : LINE_DASH_DOTTED);

      const srcGlare = getGlareRadius(si, nsm, maxConn, maxMass, maxCS, ld);
      const tgtGlare = getGlareRadius(ti, nsm, maxConn, maxMass, maxCS, ld);

      const dx = ex - sx;
      const dy = ey - sy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.001) continue;
      const ux = dx / dist;
      const uy = dy / dist;

      const dotSize = 4;
      const arrowGap = 2;
      const hasTargetDot = !renderAsParent && nodeIds[si] === nodeIds[si]; // always true for source node
      const hasSourceDot = renderAsParent || (!renderAsParent && hasFwd && hasRev);
      const targetOffset = hasTargetDot && !renderAsParent ? (arrowGap + dotSize) : arrowGap;
      const sourceOffset = hasSourceDot ? (arrowGap + dotSize) : arrowGap;
      const trimStart = srcGlare + sourceOffset;
      const trimEnd = tgtGlare + targetOffset;
      if (trimStart + trimEnd >= dist) continue;

      const lsx = sx + ux * trimStart;
      const lsy = sy + uy * trimStart;
      const lex = ex - ux * trimEnd;
      const ley = ey - uy * trimEnd;
      const lineAngle = Math.atan2(dy, dx);

      if (isClass) {
        // Wavy line
        const ldx = lex - lsx, ldy = ley - lsy;
        const lineLen = Math.sqrt(ldx * ldx + ldy * ldy);
        const segs = Math.max(Math.floor(lineLen / 2), 10);
        ctx.beginPath();
        ctx.moveTo(lsx, lsy);
        for (let s = 1; s < segs; s++) {
          const tp = s / segs;
          const bx = lsx + ldx * tp;
          const by = lsy + ldy * tp;
          const wo = Math.sin(tp * lineLen * 0.3) * 3;
          const pa = lineAngle + Math.PI / 2;
          ctx.lineTo(bx + wo * Math.cos(pa), by + wo * Math.sin(pa));
        }
        ctx.lineTo(lex, ley);
        ctx.stroke();
      } else {
        ctx.moveTo(lsx, lsy);
        ctx.lineTo(lex, ley);
        ctx.stroke();
      }

      // Arrow dots
      const skipTarget = nodeUuids[ti] === '00000000-0000-0000-0001-000000000001' || nodeUuids[ti] === '00000000-0000-0000-0001-000000000002';
      const skipSource = nodeUuids[si] === '00000000-0000-0000-0001-000000000001' || nodeUuids[si] === '00000000-0000-0000-0001-000000000002';

      if (renderAsParent) {
        if (!skipSource) {
          const ra = lineAngle + Math.PI;
          const cx2 = sx - (srcGlare + 2 + dotSize / 2) * Math.cos(ra);
          const cy2 = sy - (srcGlare + 2 + dotSize / 2) * Math.sin(ra);
          ctx.beginPath();
          ctx.arc(cx2, cy2, dotSize / 2, 0, 2 * Math.PI);
          ctx.strokeStyle = hexToRgba(outlineColor, 0.8);
          ctx.lineWidth = 1.5;
          ctx.setLineDash(LINE_DASH_NONE);
          ctx.stroke();
        }
      } else {
        if (!skipTarget) {
          const cx2 = ex - (tgtGlare + 2 + dotSize / 2) * Math.cos(lineAngle);
          const cy2 = ey - (tgtGlare + 2 + dotSize / 2) * Math.sin(lineAngle);
          ctx.beginPath();
          ctx.arc(cx2, cy2, dotSize / 2, 0, 2 * Math.PI);
          ctx.fillStyle = hexToRgba(outlineColor, 0.8);
          ctx.fill();
        }
        if (hasFwd && hasRev && !skipSource) {
          const ra = lineAngle + Math.PI;
          const cx2 = sx - (srcGlare + 2 + dotSize / 2) * Math.cos(ra);
          const cy2 = sy - (srcGlare + 2 + dotSize / 2) * Math.sin(ra);
          ctx.beginPath();
          ctx.arc(cx2, cy2, dotSize / 2, 0, 2 * Math.PI);
          ctx.fillStyle = hexToRgba(outlineColor, 0.8);
          ctx.fill();
        }
      }
    }
    ctx.setLineDash(LINE_DASH_NONE);
  }

  // ==================== Level circle guides ====================
  if (viewMode === 'tree' || viewMode === 'circle') {
    const centerX = w / 2;
    const centerY = h / 2;
    const radiiSet = new Set<number>();
    for (let i = 0; i < nc; i++) {
      const r = treeRadii[i];
      if (r !== undefined && r > 0) radiiSet.add(r);
    }
    ctx.strokeStyle = hexToRgba(outlineColor, 0.1);
    ctx.lineWidth = 1;
    for (const r of radiiSet) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }

  // ==================== Draw Nodes ====================

  if (lod === 1) {
    // LOD 1: batch by color
    const colorBuckets = new Map<string, number[]>(); // color → [idx, idx, ...]
    const dimBucket: number[] = [];
    for (let i = 0; i < nc; i++) {
      const flags = states[i * 4];
      if (!(flags & 1)) continue; // not visible
      const x = positions[i * 2], y = positions[i * 2 + 1];
      if (x < vpL || x > vpR || y < vpT || y > vpB) continue;
      const glare = states[i * 4 + 1];
      if (glare === 2) { // dim
        dimBucket.push(i);
      } else {
        const color = getNodeColor(i);
        let bucket = colorBuckets.get(color);
        if (!bucket) { bucket = []; colorBuckets.set(color, bucket); }
        bucket.push(i);
      }
    }
    if (dimBucket.length > 0) {
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(dimColor, 0.15);
      for (const idx of dimBucket) {
        const x = positions[idx * 2], y = positions[idx * 2 + 1];
        ctx.moveTo(x + 1.5, y);
        ctx.arc(x, y, 1.5, 0, 2 * Math.PI);
      }
      ctx.fill();
    }
    for (const [color, bucket] of colorBuckets) {
      ctx.beginPath();
      ctx.fillStyle = color;
      for (const idx of bucket) {
        const x = positions[idx * 2], y = positions[idx * 2 + 1];
        ctx.moveTo(x + 2, y);
        ctx.arc(x, y, 2, 0, 2 * Math.PI);
      }
      ctx.fill();
    }
  } else {
    // LOD 0: Full detail
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let i = 0; i < nc; i++) {
      if (i === dragIdx) continue;
      const flags = states[i * 4];
      if (!(flags & 1)) continue; // not visible
      const x = positions[i * 2], y = positions[i * 2 + 1];
      if (x < vpL || x > vpR || y < vpT || y > vpB) continue;
      const glare: GlareState = decodeGlare(states[i * 4 + 1]);
      const isHovered = !!(flags & 2);
      const isPinned = !!(flags & 8);
      const br = getNodeRadius(i, nsm, maxConn, maxMass, maxCS, ld);
      const cr = isHovered ? br + NODE_HOVER_RADIUS_EXTRA : br;
      const nodeColor = getNodeColor(i);

      // Glare
      let glareScale = GLARE_SCALE_NORMAL;
      let glareOpacity = GLARE_OPACITY_NORMAL;
      switch (glare) {
        case 'bright': glareScale = GLARE_SCALE_BRIGHT; glareOpacity = GLARE_OPACITY_BRIGHT; break;
        case 'dim': glareOpacity = GLARE_OPACITY_DIM; break;
        case 'path': break;
        case 'current': glareScale = GLARE_SCALE_CURRENT; glareOpacity = 0.5; break;
      }
      const gr = br * glareScale;
      ctx.beginPath();
      ctx.fillStyle = glare === 'current'
        ? hexToRgba(warningColor, glareOpacity)
        : hexToRgba(nodeColor, glareOpacity);
      ctx.arc(x, y, gr, 0, 2 * Math.PI);
      ctx.fill();

      // Node circle
      let displayColor = nodeColor;
      let nodeOpacity = 1;
      if (glare === 'dim') { displayColor = dimColor; nodeOpacity = 0.25; }
      ctx.beginPath();
      ctx.globalAlpha = nodeOpacity;
      ctx.fillStyle = displayColor;
      ctx.arc(x, y, cr, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Pin indicator
      if (isPinned) {
        ctx.save();
        ctx.shadowColor = hexToRgba(outlineColor, 0.3);
        ctx.shadowBlur = 3;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.beginPath();
        ctx.fillStyle = textColor;
        ctx.arc(x, y, cr * 0.3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      // Label
      if (scale > LABEL_FADE_ZOOM_MIN) {
        const zoomOp = scale >= LABEL_FADE_ZOOM_MAX ? 1
          : (scale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
        const dimOp = glare === 'dim' ? 0.12 : 1;
        ctx.fillStyle = textColor;
        ctx.globalAlpha = zoomOp * dimOp;
        const name = displayNames[i];
        const label = name.length > 35 ? name.slice(0, 35) + '...' : name;
        ctx.fillText(label, x, y + br + 10);
        ctx.globalAlpha = 1;
      }
    }

    // Dragged node on top (LOD 0)
    if (dragIdx >= 0) {
      const i = dragIdx;
      const x = positions[i * 2], y = positions[i * 2 + 1];
      const glare: GlareState = decodeGlare(states[i * 4 + 1]);
      const isHovered = !!(states[i * 4] & 2);
      const isPinned = !!(states[i * 4] & 8);
      const br = getNodeRadius(i, nsm, maxConn, maxMass, maxCS, ld);
      const cr = isHovered ? br + NODE_HOVER_RADIUS_EXTRA : br;
      const nodeColor = getNodeColor(i);

      if (dragLift > 0) {
        ctx.save();
        ctx.shadowColor = hexToRgba(outlineColor, 0.3 * dragLift);
        ctx.shadowBlur = 12 * dragLift;
        ctx.shadowOffsetX = 4 * dragLift;
        ctx.shadowOffsetY = 4 * dragLift;
        ctx.beginPath();
        ctx.fillStyle = nodeColor;
        ctx.arc(x, y, cr, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      let gs = GLARE_SCALE_NORMAL, go = GLARE_OPACITY_NORMAL;
      switch (glare) {
        case 'bright': gs = GLARE_SCALE_BRIGHT; go = GLARE_OPACITY_BRIGHT; break;
        case 'dim': go = GLARE_OPACITY_DIM; break;
        case 'current': gs = GLARE_SCALE_CURRENT; go = 0.5; break;
      }
      ctx.beginPath();
      ctx.fillStyle = glare === 'current'
        ? hexToRgba(warningColor, go)
        : hexToRgba(nodeColor, go);
      ctx.arc(x, y, br * gs, 0, 2 * Math.PI);
      ctx.fill();

      ctx.beginPath();
      if (glare === 'dim') {
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = dimColor;
      } else {
        ctx.fillStyle = nodeColor;
      }
      ctx.arc(x, y, cr, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isPinned) {
        ctx.save();
        ctx.shadowColor = hexToRgba(outlineColor, 0.3);
        ctx.shadowBlur = 3;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.beginPath();
        ctx.fillStyle = textColor;
        ctx.arc(x, y, cr * 0.3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      if (scale > LABEL_FADE_ZOOM_MIN) {
        const zoomOp = scale >= LABEL_FADE_ZOOM_MAX ? 1
          : (scale - LABEL_FADE_ZOOM_MIN) / (LABEL_FADE_ZOOM_MAX - LABEL_FADE_ZOOM_MIN);
        const dimOp = glare === 'dim' ? 0.12 : 1;
        ctx.fillStyle = textColor;
        ctx.globalAlpha = zoomOp * dimOp;
        ctx.font = '10px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const name = displayNames[i];
        const label = name.length > 35 ? name.slice(0, 35) + '...' : name;
        ctx.fillText(label, x, y + br + 10);
        ctx.globalAlpha = 1;
      }
    }
  }

  ctx.restore();
}

// ==================== Message Handler ====================

self.onmessage = (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      canvas = msg.canvas;
      width = msg.width;
      height = msg.height;
      dpr = msg.dpr;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx = canvas.getContext('2d');
      if (ctx && dpr !== 1) {
        ctx.scale(dpr, dpr);
      }
      (self as unknown as { postMessage(msg: unknown): void }).postMessage({ type: 'ready' });
      break;
    }
    case 'resize': {
      width = msg.width;
      height = msg.height;
      dpr = msg.dpr;
      if (canvas) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        if (ctx && dpr !== 1) {
          ctx.resetTransform();
          ctx.scale(dpr, dpr);
        }
      }
      break;
    }
    case 'nodeMetadata': {
      const m = msg as NodeMetadataMessage;
      nodeIds = m.nodeIds;
      nodeUuids = m.nodeUuids;
      displayNames = m.displayNames;
      connectionCounts = m.connectionCounts;
      inLinkCounts = m.inLinkCounts;
      outLinkCounts = m.outLinkCounts;
      masses = m.masses;
      contentSizes = m.contentSizes;
      nodeTypeIds = m.nodeTypeIds;
      nodeColors = m.nodeColors;
      _isClassNodes = m.isClassNodes;
      treeRadii = m.treeRadii;
      break;
    }
    case 'style': {
      const s = msg as StyleMessage;
      classColorMap.clear();
      for (const cc of s.classColors) {
        classColorMap.set(cc.classId, cc.color);
      }
      textColor = s.textColor;
      accentColor = s.accentColor;
      dimColor = s.dimColor;
      outlineColor = s.outlineColor;
      warningColor = s.warningColor;
      hexCache.clear(); // colors changed, invalidate cache
      break;
    }
    case 'frame': {
      renderFrame(msg as FrameMessage);
      break;
    }
    case 'destroy': {
      canvas = null;
      ctx = null;
      break;
    }
  }
};
