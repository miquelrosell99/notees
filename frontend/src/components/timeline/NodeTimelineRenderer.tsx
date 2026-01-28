/**
 * NodeTimelineRenderer Component
 * 
 * Timeline visualization with gravity-point based physics.
 * Nodes cluster around time anchors that adapt based on zoom level.
 * 
 * Features:
 * - Gravity points (time anchors) prevent oscillation
 * - Deterministic lane assignment for vertical positioning
 * - Adaptive zoom (decade to hour granularity)
 * - Stable physics with convergence detection
 * - Type-based coloring
 * - Journal page indicators
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useClasses, usePages } from '@/hooks';
import { useNodesStore } from '@/stores';
import { getSettings, setSetting } from '@/api/databases';
import type { Node } from '@/types';
import type { TimelineNode, GravityPoint, TypeColor, DateProperty, TimelineTransform, NodeTimelineRendererProps } from './types';
import { mdiCog, mdiPalette, mdiCalendarPlus, mdiCalendarEdit, mdiCalendarClock, mdiMagnify, mdiArrowExpandHorizontal, mdiArrowExpandVertical, mdiAlphaD, mdiAlphaY, mdiAlphaS, mdiAlphaQ, mdiAlphaM, mdiAlphaW } from '@mdi/js';
import { Button } from '../core/Button';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { SelectionButton } from '../core/SelectionButton';
import { ToggleSwitch } from '../core/ToggleSwitch';
import { TypeColorsPanel } from '../shared/TypeColorsPanel';
import { generateGravityPoints, assignNodesToGravityPoints, getZoomLevelFromScale } from './utils/gravityPoints';
import { assignLanes } from './utils/laneAssignment';
import { getDateRange, normalizeDate } from './utils/dateUtils';
import './NodeTimelineRenderer.css';

// Physics constants
const GRAVITY_ATTRACTION = 0.035;
const LANE_PULL_STRENGTH = 0.15;
const INTER_NODE_REPULSION = 300;
const VELOCITY_DAMPING = 0.88;
const MIN_VELOCITY = 0.05;
const NODE_RADIUS = 8;
const HOVER_RADIUS_EXTRA = 3;

// Zoom constants
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const ZOOM_SPEED_WHEEL = 0.002;      // Mouse wheel (discrete, larger deltas)
const ZOOM_SPEED_PINCH = 0.01;       // Trackpad pinch-to-zoom

export function NodeTimelineRenderer({
  nodes,
  dateProperty = 'create_date',
  onNodeClick,
  onNodeShiftClick,
  className = '',
}: NodeTimelineRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const timelineNodesRef = useRef<TimelineNode[]>([]);
  const gravityPointsRef = useRef<GravityPoint[]>([]);
  const dragNodeRef = useRef<TimelineNode | null>(null);
  const isSettledRef = useRef(false);
  
  const { openNode } = useNodesStore();
  const { data: classes } = useClasses();
  const { data: pages } = usePages();
  
  // State
  const [typeColors, setTypeColors] = useState<TypeColor[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [transform, setTransform] = useState<TimelineTransform>({ panX: 0, scale: 1.0 });
  const [hoveredNode, setHoveredNode] = useState<TimelineNode | null>(null);
  const [hoveredGravityPoint, setHoveredGravityPoint] = useState<GravityPoint | null>(null);
  const [currentDateProperty, setCurrentDateProperty] = useState<DateProperty>(dateProperty);
  const [zoomPreset, setZoomPreset] = useState<'decade' | 'year' | 'semester' | 'quatrimester' | 'month' | 'week' | 'custom'>('year');
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
  
  const transformRef = useRef(transform);
  const settingsLoadedRef = useRef(false);
  const typeColorsLoadedRef = useRef(false);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, panX: 0 });
  
  // Derived state
  const currentZoomLevel = useMemo(() => getZoomLevelFromScale(transform.scale), [transform.scale]);
  
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
        setCurrentDateProperty(savedDate as DateProperty);
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
      setSetting('timeline_date_property', currentDateProperty).catch(e => {
        console.error('Failed to save timeline_date_property:', e);
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [currentDateProperty]);
  
  // Apply initial year zoom preset on mount
  useEffect(() => {
    const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
    if (totalDays > 0) {
      const targetDays = 365; // year
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, totalDays / targetDays));
      setTransform(prev => ({ ...prev, scale: newScale }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount
  
  // Keep transform ref in sync
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);
  
  // Build page UUID map
  const pageUuidMap = useMemo(() => {
    const map = new Map<string, Node>();
    if (pages) {
      for (const page of pages) {
        map.set(page.uuid, page);
      }
    }
    return map;
  }, [pages]);
  
  // Get node color
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
    const dateStr = node[currentDateProperty];
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  }, [currentDateProperty]);
  
  // Filter to pages with dates
  const pageNodes = useMemo(() => {
    const filtered = nodes
      .filter(n => n.is_page)
      .map(node => {
        const date = getNodeDate(node);
        return date ? { node, date } : null;
      })
      .filter((item): item is { node: Node; date: Date } => item !== null)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    
    console.log('[Timeline] Filtered pages:', filtered.length, 'from', nodes.length, 'total nodes');
    return filtered;
  }, [nodes, getNodeDate]);
  
  // Calculate date range
  const dateRange = useMemo(() => {
    const dates = pageNodes.map(p => p.date);
    return getDateRange(dates, 0.1);
  }, [pageNodes]);
  
  // Generate gravity points
  useEffect(() => {
    const gravityPoints = generateGravityPoints(
      dateRange.start,
      dateRange.end,
      currentZoomLevel,
      pageUuidMap
    );
    
    // Keep positions normalized (0-1)
    gravityPoints.forEach(gp => {
      gp.x = gp.position;
    });
    
    gravityPointsRef.current = gravityPoints;
  }, [dateRange, currentZoomLevel, dimensions.width, pageUuidMap]);
  
  // Initialize timeline nodes
  useEffect(() => {
    const { start, end } = dateRange;
    
    const newTimelineNodes: TimelineNode[] = pageNodes.map(({ node, date }) => {
      const position = normalizeDate(date, start, end);
      
      return {
        id: node.id,
        x: position, // Store as normalized position (0-1)
        y: 0,
        vx: 0,
        vy: 0,
        date,
        node,
        radius: NODE_RADIUS,
        color: getNodeColor(node),
        laneIndex: 0,
        targetY: 0,
        gravityPointId: '',
      };
    });
    
    timelineNodesRef.current = newTimelineNodes;
    
    console.log('[Timeline] Initialized nodes:', newTimelineNodes.length, 'Sample:', newTimelineNodes[0]);
    
    // Assign to gravity points and lanes
    if (gravityPointsRef.current.length > 0) {
      assignNodesToGravityPoints(newTimelineNodes, gravityPointsRef.current);
      assignLanes(newTimelineNodes, dimensions.width);
      console.log('[Timeline] Assigned to gravity points and lanes');
    }
    
    // Reset simulation
    isSettledRef.current = false;
  }, [pageNodes, dateRange, dimensions.width, getNodeColor]);
  
  // Reassign lanes when zoom changes
  useEffect(() => {
    if (timelineNodesRef.current.length > 0 && gravityPointsRef.current.length > 0) {
      assignNodesToGravityPoints(timelineNodesRef.current, gravityPointsRef.current);
      assignLanes(timelineNodesRef.current, dimensions.width);
      isSettledRef.current = false;
    }
  }, [currentZoomLevel, dimensions.width]);
  
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
  
  // Physics simulation
  const simulate = useCallback(() => {
    if (isSettledRef.current) return false;
    
    const nodes = timelineNodesRef.current;
    const gravityPoints = gravityPointsRef.current;
    
    let maxVelocity = 0;
    
    for (const node of nodes) {
      // 1. Attraction to gravity point (in normalized space)
      const gravityPoint = gravityPoints.find(gp => gp.id === node.gravityPointId);
      if (gravityPoint) {
        const dx = gravityPoint.x - node.x;
        node.vx += dx * GRAVITY_ATTRACTION;
      }
      
      // 2. Pull toward assigned lane
      if (!dragNodeRef.current || dragNodeRef.current.id !== node.id) {
        const dy = node.targetY - node.y;
        node.vy += dy * LANE_PULL_STRENGTH;
      }
      
      // 3. Horizontal repulsion from nearby nodes (in normalized space)
      for (const other of nodes) {
        if (other.id === node.id) continue;
        if (other.gravityPointId !== node.gravityPointId) continue; // Only within same cluster
        
        const dx = node.x - other.x;
        const horizontalDist = Math.abs(dx * dimensions.width); // Convert to pixels for distance check
        
        if (horizontalDist < 50) {
          const force = INTER_NODE_REPULSION / (horizontalDist * horizontalDist + 1);
          node.vx += Math.sign(dx || 1) * force * 0.00005; // Scaled for normalized space
        }
      }
      
      // 4. Apply damping and update
      node.vx *= VELOCITY_DAMPING;
      node.vy *= VELOCITY_DAMPING;
      node.x += node.vx;
      node.y += node.vy;
      
      // Track max velocity for convergence
      maxVelocity = Math.max(maxVelocity, Math.abs(node.vx), Math.abs(node.vy));
    }
    
    // Check convergence
    if (maxVelocity < MIN_VELOCITY && !dragNodeRef.current) {
      isSettledRef.current = true;
      return false;
    }
    
    return true;
  }, [dimensions.height]);
  
  // Render
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) {
      console.log('[Timeline] Render: No canvas or context');
      return;
    }
    
    const { width, height } = dimensions;
    const { panX, scale } = transformRef.current;
    const centerY = height / 2;
    
    const nodes = timelineNodesRef.current;
    const gravityPoints = gravityPointsRef.current;
    
    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Draw gravity point zones (subtle background)
    if (gravityPoints.length > 1) {
      gravityPoints.forEach((gp, i) => {
        const x = gp.x * scale + panX;
        const nextGp = gravityPoints[i + 1];
        const nextX = nextGp ? nextGp.x * scale + panX : width;
        
        if (x > width || nextX < 0) return;
        
        ctx.fillStyle = i % 2 === 0 ? 'rgba(100, 100, 255, 0.02)' : 'rgba(150, 100, 255, 0.02)';
        ctx.fillRect(Math.max(0, x), 0, Math.min(width, nextX) - Math.max(0, x), height);
      });
    }
    
    // Draw center timeline
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    
    // Draw gravity point markers
    gravityPoints.forEach(gp => {
      const x = gp.x * width * scale + panX;
      if (x < -50 || x > width + 50) return;
      
      const isHovered = hoveredGravityPoint?.id === gp.id;
      
      // Tick mark
      ctx.strokeStyle = gp.hasPage ? '#6366f1' : '#666';
      ctx.lineWidth = gp.hasPage ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, centerY - 10);
      ctx.lineTo(x, centerY + 10);
      ctx.stroke();
      
      // Label
      ctx.fillStyle = isHovered ? '#fff' : (gp.hasPage ? '#aaa' : '#888');
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(gp.label, x, centerY + 25);
      
      // Page indicator
      if (gp.hasPage) {
        ctx.fillStyle = isHovered ? '#8b8ff1' : '#6366f1';
        ctx.beginPath();
        ctx.arc(x, centerY, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    
    // Draw connector lines and nodes
    if (nodes.length === 0) {
      // Debug: show message if no nodes
      console.log('[Timeline] Render: No nodes in array');
      ctx.fillStyle = '#888';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No timeline nodes to display', width / 2, height / 2);
      return;
    }
    
    console.log('[Timeline] Rendering', nodes.length, 'nodes. First node:', { x: nodes[0].x, y: nodes[0].y, color: nodes[0].color });
    
    // First pass: connector lines
    nodes.forEach(node => {
      const x = node.x * width * scale + panX;
      const y = centerY + node.y;
      
      if (x < -100 || x > width + 100) return;
      
      ctx.strokeStyle = node.color + '20';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, centerY);
      ctx.stroke();
    });
    
    // Second pass: nodes
    nodes.forEach(node => {
      const x = node.x * width * scale + panX;
      const y = centerY + node.y;
      
      if (x < -100 || x > width + 100) return;
      
      const isHovered = hoveredNode?.id === node.id;
      const radius = isHovered ? node.radius + HOVER_RADIUS_EXTRA : node.radius;
      
      // Glow when hovered
      if (isHovered) {
        ctx.fillStyle = node.color + '30';
        ctx.beginPath();
        ctx.arc(x, y, radius + 6, 0, 2 * Math.PI);
        ctx.fill();
      }
      
      // Node circle
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fill();
      
      // Label
      if (isHovered) {
        ctx.fillStyle = '#fff';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        const textY = y < centerY ? y - radius - 8 : y + radius + 15;
        ctx.fillText(node.node.name || 'Untitled', x, textY);
      }
    });
  }, [dimensions, hoveredNode, hoveredGravityPoint]);
  
  // Animation loop
  useEffect(() => {
    const loop = () => {
      const shouldContinue = simulate();
      render();
      
      if (shouldContinue || !isSettledRef.current) {
        animationRef.current = requestAnimationFrame(loop);
      }
    };
    
    animationRef.current = requestAnimationFrame(loop);
    
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [simulate, render]);
  
  // Mouse interaction
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    // Check for node click
    const clickedNode = timelineNodesRef.current.find(node => {
      const nodeScreenX = node.x * dimensions.width * transform.scale + transform.panX;
      const dist = Math.sqrt((mouseX - nodeScreenX) ** 2 + (mouseY - centerY - node.y) ** 2);
      return dist < node.radius + 3;
    });
    
    if (clickedNode) {
      dragNodeRef.current = clickedNode;
      isSettledRef.current = false;
      return;
    }
    
    // Check for gravity point click
    const { panX, scale } = transform;
    const clickedGP = gravityPointsRef.current.find(gp => {
      const x = gp.x * scale + panX;
      return Math.abs(mouseX - x) < 10 && Math.abs(mouseY - centerY) < 15;
    });
    
    if (clickedGP && clickedGP.hasPage && clickedGP.uuid) {
      const page = pageUuidMap.get(clickedGP.uuid);
      if (page) {
        openNode(page.id, 'page');
      }
      return;
    }
    
    // Start panning
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, panX: transform.panX };
  }, [dimensions, transform, pageUuidMap, openNode]);
  
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    // Dragging node
    if (dragNodeRef.current) {
      dragNodeRef.current.y = mouseY - centerY;
      dragNodeRef.current.vy = 0;
      isSettledRef.current = false;
      return;
    }
    
    // Panning
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      setTransform(prev => ({
        ...prev,
        panX: panStartRef.current.panX + dx
      }));
      isSettledRef.current = false;
      return;
    }
    
    // Hover detection - nodes
    const hovered = timelineNodesRef.current.find(node => {
      const dist = Math.sqrt((mouseX - node.x) ** 2 + (mouseY - centerY - node.y) ** 2);
      return dist < node.radius + 3;
    });
    setHoveredNode(hovered || null);
    
    // Hover detection - gravity points
    const { panX, scale } = transform;
    const hoveredGP = gravityPointsRef.current.find(gp => {
      const x = gp.x * scale + panX;
      return Math.abs(mouseX - x) < 10 && Math.abs(mouseY - centerY) < 15;
    });
    setHoveredGravityPoint(hoveredGP || null);
  }, [dimensions, transform]);
  
  const handleMouseUp = useCallback(() => {
    dragNodeRef.current = null;
    isPanningRef.current = false;
  }, []);
  
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current) return;
    
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    const clickedNode = timelineNodesRef.current.find(node => {
      const nodeScreenX = node.x * dimensions.width * transform.scale + transform.panX;
      const dist = Math.sqrt((mouseX - nodeScreenX) ** 2 + (mouseY - centerY - node.y) ** 2);
      return dist < node.radius + 3;
    });
    
    if (clickedNode) {
      if (e.shiftKey && onNodeShiftClick) {
        onNodeShiftClick(clickedNode.node);
      } else if (onNodeClick) {
        onNodeClick(clickedNode.node);
      } else {
        openNode(clickedNode.node.id, 'page');
      }
    }
  }, [dimensions, onNodeClick, onNodeShiftClick, openNode]);
  
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd + Scroll = Zoom (prevent browser zoom)
      e.preventDefault();
      
      const mouseX = e.clientX - rect.left;
      const delta = -e.deltaY;
      
      // Detect input type and adjust zoom speed
      let zoomSpeed: number;
      if (Math.abs(e.deltaY) > 50) {
        // Mouse wheel (larger discrete values)
        zoomSpeed = ZOOM_SPEED_WHEEL;
      } else {
        // Trackpad pinch or scroll (smaller continuous values)
        zoomSpeed = ZOOM_SPEED_PINCH;
      }
      
      const zoomFactor = 1 + delta * zoomSpeed;
      
      setTransform(prev => {
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * zoomFactor));
        const scaleRatio = newScale / prev.scale;
        
        // Zoom toward mouse position
        const newPanX = mouseX - (mouseX - prev.panX) * scaleRatio;
        
        return {
          scale: newScale,
          panX: newPanX
        };
      });
      
      setZoomPreset('custom');
    } else {
      // Normal scroll = Pan horizontally
      e.preventDefault();
      
      const delta = -e.deltaY;
      
      setTransform(prev => ({
        ...prev,
        panX: prev.panX + delta
      }));
    }
    
    isSettledRef.current = false;
  }, []);
  
  // Calculate scale to fit a specific number of days in viewport
  const calculateScaleForDays = useCallback((targetDays: number): number => {
    const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
    if (totalDays <= 0) return 1.0;
    return totalDays / targetDays;
  }, [dateRange]);
  
  // Zoom to preset (decade/year/semester/quatrimester/month/week)
  const zoomToPreset = useCallback((preset: 'decade' | 'year' | 'semester' | 'quatrimester' | 'month' | 'week') => {
    const targetDays = 
      preset === 'decade' ? 3650 :
      preset === 'year' ? 365 :
      preset === 'semester' ? 180 :
      preset === 'quatrimester' ? 120 :
      preset === 'month' ? 30 :
      7; // week
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, calculateScaleForDays(targetDays)));
    
    setTransform(prev => ({
      ...prev,
      scale: newScale
    }));
    setZoomPreset(preset);
    isSettledRef.current = false;
  }, [calculateScaleForDays]);
  
  // Recenter view
  const recenter = useCallback(() => {
    setTransform({ panX: 0, scale: 1.0 });
    setZoomPreset('custom');
    isSettledRef.current = false;
  }, []);
  
  // Search and scroll to node
  const scrollToNode = useCallback((node: Node) => {
    const tNode = timelineNodesRef.current.find(t => t.id === node.id);
    if (tNode) {
      const targetX = tNode.x * dimensions.width * transform.scale;
      const newPanX = dimensions.width / 2 - targetX;
      setTransform(prev => ({ ...prev, panX: newPanX }));
      isSettledRef.current = false;
    }
    setSearchQuery('');
    setSearchOpen(false);
  }, [dimensions, transform.scale]);
  
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
      <div className={`node-timeline-renderer node-timeline-renderer--empty ${className}`}>
        <div className="node-timeline-renderer__empty-message">
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
  
  const zoomPresetOptions = [
    { value: 'decade', label: 'Decade', icon: mdiAlphaD },
    { value: 'year', label: 'Year', icon: mdiAlphaY },
    { value: 'semester', label: 'Semester', icon: mdiAlphaS },
    { value: 'quatrimester', label: 'Quatrimester', icon: mdiAlphaQ },
    { value: 'month', label: 'Month', icon: mdiAlphaM },
    { value: 'week', label: 'Week', icon: mdiAlphaW },
  ];
  
  return (
    <div className={`node-timeline-renderer ${className}`} ref={containerRef}>
      <div className="node-timeline-renderer__controls">
        <div className="node-timeline-renderer__controls-left">
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
                  value={currentDateProperty}
                  onChange={(val) => setCurrentDateProperty(val as DateProperty)}
                  size="sm"
                />
              </div>
              
              <div className="settings-group">
                <label className="settings-label-text">Current Zoom</label>
                <div className="timeline-zoom-display">{currentZoomLevel}</div>
                <p className="settings-hint">Use mouse wheel to zoom</p>
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
        
        <div className="node-timeline-renderer__controls-right">
          <div className="timeline-search-panel">
            <Button
              icon={mdiMagnify}
              size="sm"
              variant="ghost"
              onClick={() => setSearchOpen(!searchOpen)}
              title="Search pages"
            />
            {searchOpen && (
              <div className="timeline-search-dropdown">
                <input
                  type="text"
                  className="timeline-search-input"
                  placeholder="Search to navigate..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => setTimeout(() => setSearchOpen(false), 200)}
                  autoFocus
                />
                {searchResults.length > 0 && (
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
            )}
          </div>
        </div>
      </div>
      
      <div className="node-timeline-renderer__bottom-controls">
        <SelectionButton
          options={zoomPresetOptions}
          value={zoomPreset === 'custom' ? 'year' : zoomPreset}
          onChange={(val) => zoomToPreset(val as any)}
          size="sm"
        />
        
        <ToggleSwitch
          leftLabel="Horizontal"
          rightLabel="Vertical"
          checked={orientation === 'vertical'}
          onChange={(checked) => setOrientation(checked ? 'vertical' : 'horizontal')}
          size="sm"
        />
      </div>
      
      <canvas
        ref={canvasRef}
        className="node-timeline-renderer__canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onWheelCapture={handleWheel}
      />
    </div>
  );
}
