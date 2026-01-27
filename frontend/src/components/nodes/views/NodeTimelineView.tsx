/**
 * NodeTimelineView Component
 * 
 * Timeline visualization with horizontal date axis and circular nodes.
 * 
 * Features:
 * - Center horizontal timeline with year/month/day markers
 * - Circular nodes (reused from graph view) positioned vertically above/below timeline
 * - Physics simulation for vertical positioning to avoid collisions
 * - Zoom controls for date scale (year/month/day/week)
 * - Date-based sorting options (created_at, write_date, open_date)
 * - Type coloring (shared with graph view)
 * - Clickable date markers to open daily/monthly/yearly pages
 * - Search to navigate to specific nodes
 * - Only shows pages (not blocks)
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useClasses, usePages } from '@/hooks';
import { useNodesStore } from '@/stores';
import { getSettings, setSetting } from '@/api/databases';
import type { Node } from '@/types';
import { mdiCog, mdiPalette, mdiCrosshairsGps, mdiCalendar, mdiCalendarWeek, mdiCalendarToday, mdiCalendarPlus, mdiCalendarEdit, mdiCalendarClock } from '@mdi/js';
import { Button } from '../../core/Button';
import { ButtonWithPanel } from '../../core/ButtonWithPanel';
import { SelectionButton } from '../../core/SelectionButton';
import { TypeColorsPanel, type TypeColor } from '../../shared/TypeColorsPanel';
import './NodeTimelineView.css';

export interface NodeTimelineViewProps {
  /** Nodes to display (will be filtered to pages only) */
  nodes: Node[];
  /** Click handler */
  onNodeClick?: (node: Node) => void;
  /** Shift-click handler */
  onNodeShiftClick?: (node: Node) => void;
  /** CSS class */
  className?: string;
}

type DateProperty = 'create_date' | 'write_date' | 'open_date';
type ZoomLevel = 'year' | 'month' | 'week' | 'day';

interface TimelineNode {
  id: number;
  x: number; // Position along timeline (0-1)
  y: number; // Vertical position (pixels from center)
  vy: number; // Vertical velocity
  date: Date;
  node: Node;
  radius: number;
  color: string;
}

interface DateMarker {
  date: Date;
  label: string;
  position: number; // 0-1 along timeline
  hasPage: boolean;
  uuid?: string; // Date UUID for page lookup
}

const NODE_RADIUS = 8;
const VERTICAL_SPACING = 60;
const MIN_VERTICAL_DISTANCE = 35;
const COLLISION_DAMPING = 0.7;
const RETURN_FORCE = 0.05;
const DRAG_DAMPING = 0.92;

// Date UUID helpers
function formatDateUuid(date: Date, type: 'day' | 'month' | 'year'): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  if (type === 'day') return `${year}${month}${day}`;
  if (type === 'month') return `${year}${month}00`;
  return `${year}0000`;
}

export function NodeTimelineView({
  nodes,
  onNodeClick,
  onNodeShiftClick,
  className = '',
}: NodeTimelineViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const timelineNodesRef = useRef<TimelineNode[]>([]);
  const dragNodeRef = useRef<TimelineNode | null>(null);
  
  const { openNode } = useNodesStore();
  const { data: classes } = useClasses();
  const { data: pages } = usePages();
  
  // Settings state
  const [dateProperty, setDateProperty] = useState<DateProperty>('create_date');
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>('month');
  const [typeColors, setTypeColors] = useState<TypeColor[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [pan, setPan] = useState(0); // Horizontal pan offset
  const [hoveredNode, setHoveredNode] = useState<TimelineNode | null>(null);
  const [hoveredMarker, setHoveredMarker] = useState<DateMarker | null>(null);
  
  const settingsLoadedRef = useRef(false);
  const typeColorsLoadedRef = useRef(false);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, pan: 0 });
  
  // Load settings
  useEffect(() => {
    if (typeColorsLoadedRef.current) return;
    
    getSettings().then(settings => {
      const saved = settings['graph_type_colors'];
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            setTypeColors(parsed);
          }
        } catch (e) {
          console.error('Failed to parse graph_type_colors:', e);
        }
      }
      typeColorsLoadedRef.current = true;
    }).catch(e => {
      console.error('Failed to load settings:', e);
      typeColorsLoadedRef.current = true;
    });
  }, []);
  
  useEffect(() => {
    if (settingsLoadedRef.current) return;
    
    getSettings().then(settings => {
      const savedDate = settings['timeline_date_property'];
      if (savedDate && ['create_date', 'write_date', 'open_date'].includes(savedDate)) {
        setDateProperty(savedDate as DateProperty);
      }
      const savedZoom = settings['timeline_zoom_level'];
      if (savedZoom && ['year', 'month', 'week', 'day'].includes(savedZoom)) {
        setZoomLevel(savedZoom as ZoomLevel);
      }
      settingsLoadedRef.current = true;
    }).catch(e => {
      console.error('Failed to load timeline settings:', e);
      settingsLoadedRef.current = true;
    });
  }, []);
  
  // Save settings
  useEffect(() => {
    if (!typeColorsLoadedRef.current) return;
    const timer = setTimeout(() => {
      setSetting('graph_type_colors', JSON.stringify(typeColors)).catch(e => {
        console.error('Failed to save graph_type_colors:', e);
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [typeColors]);
  
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const timer = setTimeout(() => {
      setSetting('timeline_date_property', dateProperty).catch(e => {
        console.error('Failed to save timeline_date_property:', e);
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [dateProperty]);
  
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    const timer = setTimeout(() => {
      setSetting('timeline_zoom_level', zoomLevel).catch(e => {
        console.error('Failed to save timeline_zoom_level:', e);
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [zoomLevel]);
  
  // Build page UUID map for date markers
  const pageUuidMap = useMemo(() => {
    const map = new Map<string, Node>();
    if (pages) {
      for (const page of pages) {
        map.set(page.uuid, page);
      }
    }
    return map;
  }, [pages]);
  
  // Get node color based on type
  const getNodeColor = useCallback((node: Node): string => {
    if (node.color) return node.color;
    
    if (node.classes && node.classes.length > 0 && typeColors.length > 0) {
      const sortedTypeColors = [...typeColors].sort((a, b) => a.order - b.order);
      for (const typeColor of sortedTypeColors) {
        if (node.classes.includes(typeColor.typeId)) {
          return typeColor.color;
        }
      }
    }
    
    return '#6366f1';
  }, [typeColors]);
  
  // Extract date from node
  const getNodeDate = useCallback((node: Node): Date | null => {
    const dateStr = node[dateProperty];
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  }, [dateProperty]);
  
  // Filter to pages only and extract dates
  const pageNodes = useMemo(() => {
    return nodes
      .filter(n => n.is_page)
      .map(node => {
        const date = getNodeDate(node);
        return date ? { node, date } : null;
      })
      .filter((item): item is { node: Node; date: Date } => item !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [nodes, getNodeDate]);
  
  // Calculate date range
  const dateRange = useMemo(() => {
    if (pageNodes.length === 0) {
      const now = new Date();
      const start = new Date(now);
      start.setMonth(now.getMonth() - 6);
      const end = new Date(now);
      end.setMonth(now.getMonth() + 1);
      return { start, end };
    }
    
    const start = new Date(pageNodes[0].date);
    const end = new Date(pageNodes[pageNodes.length - 1].date);
    
    // Add padding based on zoom level
    const padding = zoomLevel === 'year' ? 365 * 24 * 60 * 60 * 1000
                  : zoomLevel === 'month' ? 30 * 24 * 60 * 60 * 1000
                  : zoomLevel === 'week' ? 7 * 24 * 60 * 60 * 1000
                  : 24 * 60 * 60 * 1000;
    
    start.setTime(start.getTime() - padding);
    end.setTime(end.getTime() + padding);
    
    return { start, end };
  }, [pageNodes, zoomLevel]);
  
  // Generate date markers
  const dateMarkers = useMemo((): DateMarker[] => {
    const markers: DateMarker[] = [];
    const { start, end } = dateRange;
    const totalMs = end.getTime() - start.getTime();
    
    const addMarker = (date: Date, label: string, type: 'day' | 'month' | 'year') => {
      const position = (date.getTime() - start.getTime()) / totalMs;
      const uuid = formatDateUuid(date, type);
      const hasPage = pageUuidMap.has(uuid);
      markers.push({ date, label, position, hasPage, uuid });
    };
    
    if (zoomLevel === 'year') {
      const year = start.getFullYear();
      const endYear = end.getFullYear();
      for (let y = year; y <= endYear; y++) {
        const date = new Date(y, 0, 1);
        addMarker(date, String(y), 'year');
      }
    } else if (zoomLevel === 'month') {
      const current = new Date(start);
      current.setDate(1);
      while (current <= end) {
        const label = current.toLocaleDateString('default', { month: 'short', year: 'numeric' });
        addMarker(new Date(current), label, 'month');
        current.setMonth(current.getMonth() + 1);
      }
    } else if (zoomLevel === 'week') {
      const current = new Date(start);
      // Align to Monday
      const day = current.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      current.setDate(current.getDate() + diff);
      
      while (current <= end) {
        const label = current.toLocaleDateString('default', { month: 'short', day: 'numeric' });
        addMarker(new Date(current), label, 'day');
        current.setDate(current.getDate() + 7);
      }
    } else {
      // day level
      const current = new Date(start);
      current.setHours(0, 0, 0, 0);
      while (current <= end) {
        const label = current.toLocaleDateString('default', { month: 'short', day: 'numeric' });
        addMarker(new Date(current), label, 'day');
        current.setDate(current.getDate() + 1);
      }
    }
    
    return markers;
  }, [dateRange, zoomLevel, pageUuidMap]);
  
  // Initialize timeline nodes
  useEffect(() => {
    const { start, end } = dateRange;
    const totalMs = end.getTime() - start.getTime();
    
    const newTimelineNodes: TimelineNode[] = pageNodes.map(({ node, date }) => {
      const x = (date.getTime() - start.getTime()) / totalMs;
      return {
        id: node.id,
        x,
        y: 0,
        vy: 0,
        date,
        node,
        radius: NODE_RADIUS,
        color: getNodeColor(node),
      };
    });
    
    timelineNodesRef.current = newTimelineNodes;
  }, [pageNodes, dateRange, getNodeColor]);
  
  // Handle canvas resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setDimensions({ width, height });
        if (canvasRef.current) {
          canvasRef.current.width = width * window.devicePixelRatio;
          canvasRef.current.height = height * window.devicePixelRatio;
          const ctx = canvasRef.current.getContext('2d');
          if (ctx) {
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
          }
        }
      }
    };
    
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);
  
  // Physics simulation for vertical positioning
  const simulate = useCallback(() => {
    const nodes = timelineNodesRef.current;
    const centerY = dimensions.height / 2;
    
    // Apply vertical collision forces
    for (let i = 0; i < nodes.length; i++) {
      const nodeA = nodes[i];
      
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeB = nodes[j];
        
        // Check horizontal overlap (with margin)
        const xA = nodeA.x * dimensions.width + pan;
        const xB = nodeB.x * dimensions.width + pan;
        const horizontalDist = Math.abs(xA - xB);
        
        if (horizontalDist < MIN_VERTICAL_DISTANCE) {
          // Nodes overlap horizontally, apply vertical repulsion
          const verticalDist = Math.abs(nodeA.y - nodeB.y);
          if (verticalDist < MIN_VERTICAL_DISTANCE) {
            const overlap = MIN_VERTICAL_DISTANCE - verticalDist;
            const direction = nodeA.y > nodeB.y ? 1 : -1;
            const force = overlap * 0.5;
            nodeA.vy += direction * force;
            nodeB.vy -= direction * force;
          }
        }
      }
      
      // Return force toward assigned track (above or below center)
      if (!dragNodeRef.current || dragNodeRef.current.id !== nodeA.id) {
        const targetY = (i % 2 === 0) ? -VERTICAL_SPACING : VERTICAL_SPACING;
        const diff = targetY - nodeA.y;
        nodeA.vy += diff * RETURN_FORCE;
      }
      
      // Apply damping
      nodeA.vy *= DRAG_DAMPING;
      
      // Update position
      nodeA.y += nodeA.vy;
      
      // Clamp to canvas bounds
      const maxY = centerY - nodeA.radius - 20;
      if (Math.abs(nodeA.y) > maxY) {
        nodeA.y = Math.sign(nodeA.y) * maxY;
        nodeA.vy *= -COLLISION_DAMPING;
      }
    }
  }, [dimensions, pan]);
  
  // Render loop
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    
    const { width, height } = dimensions;
    const centerY = height / 2;
    
    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Draw center timeline
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    
    // Draw date markers
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    dateMarkers.forEach(marker => {
      const x = marker.position * width + pan;
      if (x < -50 || x > width + 50) return;
      
      const isHovered = hoveredMarker?.date.getTime() === marker.date.getTime();
      
      // Marker line
      ctx.strokeStyle = marker.hasPage ? '#6366f1' : '#666';
      ctx.lineWidth = marker.hasPage ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, centerY - 10);
      ctx.lineTo(x, centerY + 10);
      ctx.stroke();
      
      // Marker label
      ctx.fillStyle = isHovered ? '#fff' : (marker.hasPage ? '#aaa' : '#888');
      ctx.fillText(marker.label, x, centerY - 15);
      
      // Page indicator dot
      if (marker.hasPage) {
        ctx.fillStyle = '#6366f1';
        ctx.beginPath();
        ctx.arc(x, centerY - 20, 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    
    // Draw nodes
    timelineNodesRef.current.forEach(tNode => {
      const x = tNode.x * width + pan;
      const y = centerY + tNode.y;
      
      if (x < -50 || x > width + 50) return;
      
      const isHovered = hoveredNode?.id === tNode.id;
      const radius = isHovered ? tNode.radius + 2 : tNode.radius;
      
      // Node circle
      ctx.fillStyle = tNode.color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Glow when hovered
      if (isHovered) {
        ctx.fillStyle = tNode.color + '40';
        ctx.beginPath();
        ctx.arc(x, y, radius + 4, 0, 2 * Math.PI);
        ctx.fill();
      }
      
      // Label
      if (isHovered || hoveredNode === null) {
        ctx.fillStyle = '#fff';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(tNode.node.name || 'Untitled', x, y + radius + 12);
      }
    });
  }, [dimensions, dateMarkers, pan, hoveredNode, hoveredMarker]);
  
  // Animation loop
  useEffect(() => {
    const loop = () => {
      simulate();
      render();
      animationRef.current = requestAnimationFrame(loop);
    };
    animationRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationRef.current);
  }, [simulate, render]);
  
  // Mouse interaction
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    // Check if clicking a node
    const clickedNode = timelineNodesRef.current.find(tNode => {
      const nodeX = tNode.x * dimensions.width + pan;
      const nodeY = centerY + tNode.y;
      const dist = Math.sqrt((x - nodeX) ** 2 + (y - nodeY) ** 2);
      return dist < tNode.radius + 3;
    });
    
    if (clickedNode) {
      dragNodeRef.current = clickedNode;
      return;
    }
    
    // Check if clicking a date marker
    const clickedMarker = dateMarkers.find(marker => {
      const markerX = marker.position * dimensions.width + pan;
      return Math.abs(x - markerX) < 8 && Math.abs(y - centerY) < 15;
    });
    
    if (clickedMarker && clickedMarker.hasPage && clickedMarker.uuid) {
      const page = pageUuidMap.get(clickedMarker.uuid);
      if (page) {
        openNode(page.id, 'page');
      }
      return;
    }
    
    // Start panning
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, pan };
  }, [dimensions, pan, dateMarkers, pageUuidMap, openNode]);
  
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    if (dragNodeRef.current) {
      // Drag node vertically
      dragNodeRef.current.y = y - centerY;
      dragNodeRef.current.vy = 0;
      return;
    }
    
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      setPan(panStartRef.current.pan + dx);
      return;
    }
    
    // Hover detection for nodes
    const hovered = timelineNodesRef.current.find(tNode => {
      const nodeX = tNode.x * dimensions.width + pan;
      const nodeY = centerY + tNode.y;
      const dist = Math.sqrt((x - nodeX) ** 2 + (y - nodeY) ** 2);
      return dist < tNode.radius + 3;
    });
    setHoveredNode(hovered || null);
    
    // Hover detection for markers
    const hoveredM = dateMarkers.find(marker => {
      const markerX = marker.position * dimensions.width + pan;
      return Math.abs(x - markerX) < 8 && Math.abs(y - centerY) < 15;
    });
    setHoveredMarker(hoveredM || null);
  }, [dimensions, pan, dateMarkers]);
  
  const handleMouseUp = useCallback(() => {
    dragNodeRef.current = null;
    isPanningRef.current = false;
  }, []);
  
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    const clickedNode = timelineNodesRef.current.find(tNode => {
      const nodeX = tNode.x * dimensions.width + pan;
      const nodeY = centerY + tNode.y;
      const dist = Math.sqrt((x - nodeX) ** 2 + (y - nodeY) ** 2);
      return dist < tNode.radius + 3;
    });
    
    if (clickedNode) {
      if (e.shiftKey && onNodeShiftClick) {
        onNodeShiftClick(clickedNode.node);
      } else if (onNodeClick) {
        onNodeClick(clickedNode.node);
      }
    }
  }, [dimensions, pan, onNodeClick, onNodeShiftClick]);
  
  // Recenter view
  const recenter = useCallback(() => {
    setPan(0);
  }, []);
  
  // Search to scroll to node
  const scrollToNode = useCallback((node: Node) => {
    const tNode = timelineNodesRef.current.find(t => t.id === node.id);
    if (tNode) {
      const targetX = tNode.x * dimensions.width;
      const newPan = dimensions.width / 2 - targetX;
      setPan(newPan);
    }
    setSearchQuery('');
    setSearchOpen(false);
  }, [dimensions]);
  
  const searchResults = useMemo(() => {
    if (!searchQuery) return [];
    const query = searchQuery.toLowerCase();
    return pageNodes
      .filter(({ node }) => node.name?.toLowerCase().includes(query))
      .slice(0, 5)
      .map(({ node }) => node);
  }, [searchQuery, pageNodes]);
  
  if (pageNodes.length === 0) {
    return (
      <div className={`node-timeline-view node-timeline-view--empty ${className}`}>
        <div className="node-timeline-view__empty-message">
          No pages with dates to display
        </div>
      </div>
    );
  }
  
  const dateOptions: Array<{ value: DateProperty; label: string; icon: string }> = [
    { value: 'create_date', label: 'Created', icon: mdiCalendarPlus },
    { value: 'write_date', label: 'Modified', icon: mdiCalendarEdit },
    { value: 'open_date', label: 'Accessed', icon: mdiCalendarClock },
  ];
  
  const zoomOptions: Array<{ value: ZoomLevel; label: string; icon: string }> = [
    { value: 'year', label: 'Year', icon: mdiCalendar },
    { value: 'month', label: 'Month', icon: mdiCalendar },
    { value: 'week', label: 'Week', icon: mdiCalendarWeek },
    { value: 'day', label: 'Day', icon: mdiCalendarToday },
  ];
  
  return (
    <div className={`node-timeline-view ${className}`} ref={containerRef}>
      {/* Top Left: Settings */}
      <div className="node-timeline-view__top-left">
        <ButtonWithPanel
          icon={mdiCog}
          size="sm"
          panelPosition="right"
          panelAlignment="start"
          panelWidth={220}
          title="Timeline Settings"
          tooltip="Settings"
        >
          <div className="timeline-settings-panel">
            <div className="settings-group">
              <label className="settings-label-text">Date Property</label>
              <SelectionButton
                options={dateOptions}
                value={dateProperty}
                onChange={(val) => setDateProperty(val as DateProperty)}
                size="sm"
              />
            </div>
            
            <div className="settings-group">
              <label className="settings-label-text">Zoom Level</label>
              <SelectionButton
                options={zoomOptions}
                value={zoomLevel}
                onChange={(val) => setZoomLevel(val as ZoomLevel)}
                size="sm"
              />
            </div>
          </div>
        </ButtonWithPanel>
        
        <ButtonWithPanel
          icon={mdiPalette}
          size="sm"
          panelPosition="right"
          panelAlignment="start"
          title="Type Colors"
          tooltip="Type colors"
        >
          <TypeColorsPanel
            typeColors={typeColors}
            classes={classes}
            onChange={setTypeColors}
          />
        </ButtonWithPanel>
      </div>
      
      {/* Top Right: Search */}
      <div className="node-timeline-view__top-right">
        <div className="timeline-search-panel">
          <div className="timeline-search-input-container">
            <input
              type="text"
              className="timeline-search-input"
              placeholder="Search to navigate..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
            />
            {searchOpen && searchResults.length > 0 && (
              <div className="timeline-search-results">
                {searchResults.map((node: Node) => (
                  <Button
                    key={node.id}
                    variant="ghost"
                    className="timeline-search-result"
                    onClick={() => scrollToNode(node)}
                  >
                    {node.icon && <span className="result-icon">{node.icon}</span>}
                    <span className="result-name">{node.name || 'Untitled'}</span>
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Bottom Right: Recenter */}
      <div className="node-timeline-view__bottom-right">
        <Button
          icon={mdiCrosshairsGps}
          size="sm"
          onClick={recenter}
          title="Reset view"
        />
      </div>
      
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className="node-timeline-view__canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
      />
    </div>
  );
}
