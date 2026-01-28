/**
 * Lane Assignment Algorithm
 * 
 * Deterministically assigns nodes to vertical lanes to minimize overlap.
 * Uses greedy bin-packing strategy.
 */
import type { TimelineNode } from '../types';

const VERTICAL_LANES = 6;
const LANE_SPACING = 45;
const MIN_HORIZONTAL_SPACING = 25;

interface LaneSlot {
  x: number;
  width: number;
}

export function assignLanes(nodes: TimelineNode[], canvasWidth: number): void {
  if (nodes.length === 0) return;
  
  // Sort by exact time
  const sorted = [...nodes].sort((a, b) => a.date.getTime() - b.date.getTime());
  
  // Track occupied spaces in each lane
  const lanes: LaneSlot[][] = Array.from({ length: VERTICAL_LANES }, () => []);
  
  for (const node of sorted) {
    const nodeX = node.x;
    const nodeWidth = node.radius * 2 + MIN_HORIZONTAL_SPACING;
    
    // Find lane with minimum overlap
    let bestLane = 0;
    let minOverlap = Infinity;
    
    for (let i = 0; i < VERTICAL_LANES; i++) {
      const overlap = calculateLaneOverlap(nodeX, nodeWidth, lanes[i]);
      if (overlap < minOverlap) {
        minOverlap = overlap;
        bestLane = i;
      }
    }
    
    // Assign to best lane
    node.laneIndex = bestLane;
    
    // Alternate above/below center
    const laneGroup = Math.floor(bestLane / 2);
    const isEven = bestLane % 2 === 0;
    node.targetY = (isEven ? -1 : 1) * (laneGroup + 1) * LANE_SPACING;
    
    // Mark this space as occupied
    lanes[bestLane].push({
      x: nodeX,
      width: nodeWidth
    });
  }
}

function calculateLaneOverlap(x: number, width: number, slots: LaneSlot[]): number {
  let overlap = 0;
  const start = x - width / 2;
  const end = x + width / 2;
  
  for (const slot of slots) {
    const slotStart = slot.x - slot.width / 2;
    const slotEnd = slot.x + slot.width / 2;
    
    // Check for overlap
    if (start < slotEnd && end > slotStart) {
      const overlapStart = Math.max(start, slotStart);
      const overlapEnd = Math.min(end, slotEnd);
      overlap += overlapEnd - overlapStart;
    }
  }
  
  return overlap;
}

export function getLaneSpacing(): number {
  return LANE_SPACING;
}

export function getVerticalLanes(): number {
  return VERTICAL_LANES;
}
