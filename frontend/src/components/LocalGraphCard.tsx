/**
 * Local Graph Card component
 * 
 * A simplified graph view that shows connections for a specific node.
 * Used in the right sidebar to display the "local" graph around a page.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import './LocalGraphCard.css';
import { useGraphData, useNode } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { GraphNode as ApiGraphNode, GraphLink as ApiGraphLink } from '@/api/nodes';

// Physics constants (simplified for local view)
const LINKED_DISTANCE = 80;
const REPULSION_STRENGTH = 400;
const CENTER_GRAVITY = 0.01;
const VELOCITY_DAMPING = 0.8;

// Visual constants
const NODE_RADIUS = 8;
const CENTER_NODE_RADIUS = 12;

interface LocalGraphNode {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  name: string;
  isCenter: boolean;
  isDaily: boolean;
}

interface LocalGraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference';
}

interface LocalGraphCardProps {
  nodeId: number;
}

export function LocalGraphCard({ nodeId }: LocalGraphCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const nodesRef = useRef<LocalGraphNode[]>([]);
  const linksRef = useRef<LocalGraphLink[]>([]);
  
  const [dimensions, setDimensions] = useState({ width: 280, height: 200 });
  const [hoveredNode, setHoveredNode] = useState<LocalGraphNode | null>(null);
  
  const { data: graphData, isLoading } = useGraphData();
  const { data: centerNode } = useNode(nodeId);
  const { openNode, addSidebarCard } = useNodesStore();
  
  // Extract local subgraph centered on nodeId
  const localData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    
    // Find all directly connected node IDs
    const connectedIds = new Set<number>();
    connectedIds.add(nodeId);
    
    for (const link of graphData.links) {
      if (link.source === nodeId) {
        connectedIds.add(link.target);
      } else if (link.target === nodeId) {
        connectedIds.add(link.source);
      }
    }
    
    // Filter nodes to only include connected ones
    const localNodes = graphData.nodes.filter(n => connectedIds.has(n.id));
    
    // Filter links to only include those between local nodes
    const localLinks = graphData.links.filter(
      l => connectedIds.has(l.source) && connectedIds.has(l.target)
    );
    
    return { nodes: localNodes, links: localLinks };
  }, [graphData, nodeId]);
  
  // Initialize local graph
  useEffect(() => {
    if (localData.nodes.length === 0) return;
    
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    const radius = Math.min(centerX, centerY) * 0.6;
    
    // Position center node at center, others in a circle
    const otherNodes = localData.nodes.filter(n => n.id !== nodeId);
    
    nodesRef.current = localData.nodes.map((apiNode: ApiGraphNode) => {
      const isCenter = apiNode.id === nodeId;
      let x = centerX;
      let y = centerY;
      
      if (!isCenter) {
        const idx = otherNodes.findIndex(n => n.id === apiNode.id);
        const angle = (2 * Math.PI * idx) / otherNodes.length - Math.PI / 2;
        x = centerX + radius * Math.cos(angle);
        y = centerY + radius * Math.sin(angle);
      }
      
      return {
        id: apiNode.id,
        x,
        y,
        vx: 0,
        vy: 0,
        name: apiNode.title || 'Untitled',
        isCenter,
        isDaily: apiNode.is_daily,
      };
    });
    
    linksRef.current = localData.links.map((link: ApiGraphLink) => ({
      source: link.source,
      target: link.target,
      type: link.type,
    }));
    
    startSimulation();
    
    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [localData, dimensions, nodeId]);
  
  // Handle container resize
  useEffect(() => {
    if (!containerRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          setDimensions({ width: w, height: Math.min(h, 250) });
        }
      }
    });
    
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);
  
  const startSimulation = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const simulate = () => {
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const centerX = dimensions.width / 2;
      const centerY = dimensions.height / 2;
      
      // Apply forces
      for (const node of nodes) {
        if (node.isCenter) {
          // Keep center node at center
          node.x = centerX;
          node.y = centerY;
          continue;
        }
        
        // Center gravity for non-center nodes
        node.vx += (centerX - node.x) * CENTER_GRAVITY;
        node.vy += (centerY - node.y) * CENTER_GRAVITY;
      }
      
      // Node repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (nodes[i].isCenter || nodes[j].isCenter) continue;
          
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          if (dist < LINKED_DISTANCE * 2) {
            const force = REPULSION_STRENGTH / (dist * dist);
            nodes[i].vx -= (dx / dist) * force;
            nodes[i].vy -= (dy / dist) * force;
            nodes[j].vx += (dx / dist) * force;
            nodes[j].vy += (dy / dist) * force;
          }
        }
      }
      
      // Link attraction to center
      for (const link of links) {
        const source = nodes.find(n => n.id === link.source);
        const target = nodes.find(n => n.id === link.target);
        if (!source || !target) continue;
        
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        
        if (!source.isCenter && !target.isCenter) {
          const force = (dist - LINKED_DISTANCE) * 0.02;
          source.vx += (dx / dist) * force;
          source.vy += (dy / dist) * force;
          target.vx -= (dx / dist) * force;
          target.vy -= (dy / dist) * force;
        }
      }
      
      // Update positions
      for (const node of nodes) {
        if (!node.isCenter) {
          node.x += node.vx;
          node.y += node.vy;
          node.vx *= VELOCITY_DAMPING;
          node.vy *= VELOCITY_DAMPING;
          
          // Keep in bounds
          const margin = 20;
          node.x = Math.max(margin, Math.min(dimensions.width - margin, node.x));
          node.y = Math.max(margin, Math.min(dimensions.height - margin, node.y));
        }
      }
      
      render(ctx, nodes, links);
      animationRef.current = requestAnimationFrame(simulate);
    };
    
    simulate();
  }, [dimensions]);
  
  const render = useCallback((
    ctx: CanvasRenderingContext2D,
    nodes: LocalGraphNode[],
    links: LocalGraphLink[]
  ) => {
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    
    // Draw links
    for (const link of links) {
      const source = nodes.find(n => n.id === link.source);
      const target = nodes.find(n => n.id === link.target);
      if (!source || !target) continue;
      
      ctx.beginPath();
      ctx.strokeStyle = link.type === 'parent' 
        ? 'rgba(100, 100, 100, 0.4)' 
        : 'rgba(99, 102, 241, 0.5)';
      ctx.lineWidth = 1;
      
      if (link.type === 'parent') {
        ctx.setLineDash([3, 3]);
      } else {
        ctx.setLineDash([]);
      }
      
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.stroke();
    }
    
    ctx.setLineDash([]);
    
    // Draw nodes
    for (const node of nodes) {
      const isHovered = hoveredNode?.id === node.id;
      const radius = node.isCenter ? CENTER_NODE_RADIUS : NODE_RADIUS;
      const displayRadius = isHovered ? radius + 2 : radius;
      
      // Node circle
      ctx.beginPath();
      if (node.isCenter) {
        ctx.fillStyle = '#f59e0b'; // Amber for center
      } else if (node.isDaily) {
        ctx.fillStyle = '#10b981'; // Green for daily
      } else {
        ctx.fillStyle = '#6366f1'; // Primary for others
      }
      ctx.arc(node.x, node.y, displayRadius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Node label (only for center or hovered)
      if (node.isCenter || isHovered) {
        ctx.fillStyle = getComputedStyle(document.documentElement)
          .getPropertyValue('--text-primary').trim() || '#333';
        ctx.font = node.isCenter ? 'bold 10px Inter, sans-serif' : '9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        
        const displayName = node.name.length > 12 
          ? node.name.slice(0, 12) + '...' 
          : node.name;
        ctx.fillText(displayName, node.x, node.y + displayRadius + 3);
      }
    }
  }, [dimensions, hoveredNode]);
  
  const getNodeAtPosition = useCallback((x: number, y: number): LocalGraphNode | null => {
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const node = nodesRef.current[i];
      const dx = x - node.x;
      const dy = y - node.y;
      const hitRadius = node.isCenter ? CENTER_NODE_RADIUS + 4 : NODE_RADIUS + 4;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }, []);
  
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = getNodeAtPosition(x, y);
    setHoveredNode(node);
  }, [getNodeAtPosition]);
  
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = getNodeAtPosition(x, y);
    
    if (node) {
      if (e.shiftKey) {
        // Shift+click: open in sidebar card
        addSidebarCard(node.id, 'page');
      } else {
        // Regular click: navigate to page (updates local graph)
        openNode(node.id, 'page');
      }
    }
  }, [getNodeAtPosition, openNode, addSidebarCard]);
  
  if (isLoading) {
    return (
      <div className="local-graph-card loading">
        <div className="local-graph-loading">Loading...</div>
      </div>
    );
  }
  
  if (localData.nodes.length === 0) {
    return (
      <div className="local-graph-card empty">
        <div className="local-graph-empty">No connections</div>
      </div>
    );
  }
  
  return (
    <div className="local-graph-card" ref={containerRef}>
      <div className="local-graph-info">
        <span className="local-graph-label">
          {centerNode?.name || 'Local Graph'}
        </span>
        <span className="local-graph-stats">
          {localData.nodes.length} nodes • {localData.links.length} connections
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height - 60}
        className="local-graph-canvas"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredNode(null)}
        onClick={handleClick}
        style={{ cursor: hoveredNode ? 'pointer' : 'default' }}
      />
    </div>
  );
}

export default LocalGraphCard;
