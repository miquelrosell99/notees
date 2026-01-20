/**
 * FilteredGraphView - Graph view for filtered/queried nodes
 * 
 * Displays a subset of nodes as a graph visualization.
 * Used for tagged nodes, linked references, and query results.
 * Only shows pages (not blocks) in the graph.
 */
import { useRef, useEffect, useState, useMemo } from 'react';
import './FilteredGraphView.css';
import type { Node } from '@/types/api';
import type { GraphViewConfig } from '@/types/views';

export interface FilteredGraphViewProps {
  /** Nodes to display (will be filtered to pages only) */
  nodes: Node[];
  /** All nodes for finding connections */
  allNodes?: Node[];
  /** Initial config */
  config?: Partial<GraphViewConfig>;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number) => void;
  /** Extra CSS class */
  className?: string;
  /** Title */
  title?: string;
  /** Width */
  width?: number;
  /** Height */
  height?: number;
}

interface GraphNode {
  id: number;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  connections: number;
}

interface GraphLink {
  source: number;
  target: number;
}

/**
 * Simple force-directed layout
 */
function forceLayout(
  nodes: GraphNode[],
  links: GraphLink[],
  width: number,
  height: number,
  iterations: number = 100
): void {
  const k = Math.sqrt((width * height) / nodes.length);
  
  for (let iter = 0; iter < iterations; iter++) {
    const temperature = 1 - iter / iterations;
    
    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (k * k) / dist * temperature;
        
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        
        nodes[i].vx -= fx;
        nodes[i].vy -= fy;
        nodes[j].vx += fx;
        nodes[j].vy += fy;
      }
    }
    
    // Attraction along links
    for (const link of links) {
      const source = nodes.find(n => n.id === link.source);
      const target = nodes.find(n => n.id === link.target);
      if (!source || !target) continue;
      
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist * dist) / k * temperature * 0.5;
      
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }
    
    // Apply velocities with damping
    for (const node of nodes) {
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > 0) {
        const maxMove = k * temperature;
        const ratio = Math.min(speed, maxMove) / speed;
        node.x += node.vx * ratio;
        node.y += node.vy * ratio;
      }
      
      // Keep within bounds
      const margin = 40;
      node.x = Math.max(margin, Math.min(width - margin, node.x));
      node.y = Math.max(margin, Math.min(height - margin, node.y));
      
      // Reset velocity
      node.vx = 0;
      node.vy = 0;
    }
  }
}

/**
 * FilteredGraphView Component
 */
export function FilteredGraphView({
  nodes,
  allNodes: _allNodes,
  config,
  onNodeClick,
  className = '',
  title = 'Graph',
  width = 400,
  height = 300,
}: FilteredGraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphLinks, setGraphLinks] = useState<GraphLink[]>([]);
  
  // Filter to pages only
  const pageNodes = useMemo(() => {
    const pagesOnly = config?.pagesOnly ?? true;
    return pagesOnly ? nodes.filter(n => n.parent_id === null) : nodes;
  }, [nodes, config?.pagesOnly]);
  
  // Build graph data
  useEffect(() => {
    const nodeIds = new Set(pageNodes.map(n => n.id));
    
    // Create graph nodes
    const gNodes: GraphNode[] = pageNodes.map((node, i) => {
      const angle = (i / pageNodes.length) * Math.PI * 2;
      const radius = Math.min(width, height) * 0.3;
      return {
        id: node.id,
        label: node.name || 'Untitled',
        x: width / 2 + Math.cos(angle) * radius + (Math.random() - 0.5) * 20,
        y: height / 2 + Math.sin(angle) * radius + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        radius: 6,
        connections: 0,
      };
    });
    
    // Find links between nodes (simplified - looking for backlinks)
    const gLinks: GraphLink[] = [];
    const linkSet = new Set<string>();
    
    for (const node of pageNodes) {
      if (node.backlinks) {
        for (const bl of node.backlinks) {
          if (nodeIds.has(bl.source_node_id) || (bl.source_page_id && nodeIds.has(bl.source_page_id))) {
            const sourceId = bl.source_page_id ?? bl.source_node_id;
            if (nodeIds.has(sourceId) && sourceId !== node.id) {
              const linkKey = [Math.min(sourceId, node.id), Math.max(sourceId, node.id)].join('-');
              if (!linkSet.has(linkKey)) {
                linkSet.add(linkKey);
                gLinks.push({ source: sourceId, target: node.id });
                
                // Update connection counts
                const sn = gNodes.find(n => n.id === sourceId);
                const tn = gNodes.find(n => n.id === node.id);
                if (sn) sn.connections++;
                if (tn) tn.connections++;
              }
            }
          }
        }
      }
    }
    
    // Adjust node sizes based on connections
    const maxConnections = Math.max(...gNodes.map(n => n.connections), 1);
    for (const node of gNodes) {
      node.radius = 4 + (node.connections / maxConnections) * 8;
    }
    
    // Apply force layout
    if (gNodes.length > 1) {
      forceLayout(gNodes, gLinks, width, height, 50);
    } else if (gNodes.length === 1) {
      gNodes[0].x = width / 2;
      gNodes[0].y = height / 2;
    }
    
    setGraphNodes(gNodes);
    setGraphLinks(gLinks);
  }, [pageNodes, width, height]);
  
  // Draw graph
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Get CSS colors
    const style = getComputedStyle(canvas);
    const primaryColor = style.getPropertyValue('--color-primary').trim() || '#171717';
    const outlineColor = style.getPropertyValue('--color-outline-variant').trim() || '#e5e5e5';
    const textColor = style.getPropertyValue('--color-on-surface').trim() || '#171717';
    
    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Draw links
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 1;
    for (const link of graphLinks) {
      const source = graphNodes.find(n => n.id === link.source);
      const target = graphNodes.find(n => n.id === link.target);
      if (!source || !target) continue;
      
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    }
    
    // Draw nodes
    for (const node of graphNodes) {
      const isHovered = hoveredNode?.id === node.id;
      
      ctx.fillStyle = isHovered ? primaryColor : outlineColor;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fill();
      
      // Draw label for hovered node
      if (isHovered) {
        ctx.fillStyle = textColor;
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(node.label, node.x, node.y - node.radius - 5);
      }
    }
  }, [graphNodes, graphLinks, hoveredNode, width, height]);
  
  // Handle mouse events
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Find node under cursor
    const node = graphNodes.find(n => {
      const dx = n.x - x;
      const dy = n.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= n.radius + 4;
    });
    
    setHoveredNode(node ?? null);
    canvas.style.cursor = node ? 'pointer' : 'default';
  };
  
  const handleClick = (_e: React.MouseEvent<HTMLCanvasElement>) => {
    if (hoveredNode) {
      onNodeClick?.(hoveredNode.id);
    }
  };
  
  if (pageNodes.length === 0) {
    return (
      <div className={`filtered-graph-view filtered-graph-view--empty ${className}`}>
        <p className="filtered-graph-view__empty">No pages to display</p>
      </div>
    );
  }
  
  return (
    <div className={`filtered-graph-view ${className}`}>
      {title && <h3 className="filtered-graph-view__title">{title}</h3>}
      <div className="filtered-graph-view__canvas-container">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="filtered-graph-view__canvas"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoveredNode(null)}
          onClick={handleClick}
        />
      </div>
      <div className="filtered-graph-view__info">
        {pageNodes.length} pages · {graphLinks.length} connections
      </div>
    </div>
  );
}

export default FilteredGraphView;
