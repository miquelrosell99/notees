/**
 * TimelineView Component
 * 
 * Displays timeline with time events (date property occurrences).
 * Each event is rendered as a NodeCircle, stacked if multiple events at same time.
 */

 

import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { setSetting, useSettingsQuery } from '@/features/workspace';
import * as nodesApi from '@/api/nodes';
import { useNavigationStore } from '@/stores';
import type { Node } from '@/types';
import type { TimeEvent, DatePropertyConfig, TimelineTransform, NodeTimelineRendererProps } from '../types/timelineTypes';
import { getDateLanePalette } from '../types/viewTypes';
import { Card } from '@/components/ui/Card';
import { ButtonWithPanel } from '@/components/ui/ButtonWithPanel';
import { CalendarIcon } from '@/components/ui/icons';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { DatePropertiesPanel } from './DatePropertiesPanel';
import { NodeCollection } from '@/features/content';
import { getDateRange } from '../utils/timelineUtils/dateUtils';
import { generateTimeEvents } from '../utils/timelineUtils/timeEvents';
import { getZoomLevelFromScale } from '../utils/timelineUtils/zoomLevels';
import {
  TimelineRenderer,
  EVENT_RADIUS_MIN,
  EVENT_RADIUS_MAX,
  EVENT_STACK_SPACING,
  EVENT_OFFSET,
  MINIMAP_HEIGHT,
  MIN_SCALE,
  MAX_SCALE,
  ZOOM_SPEED_WHEEL,
  ZOOM_SPEED_PINCH,
} from '../renderers/TimelineRenderer';

import './TimelineView.css';
import './DatePropertiesPanel.css';
import { registerView } from './registry';
const rendererRef = new TimelineRenderer();

interface SpatialEntry {
  event: TimeEvent;
  x: number;
  y: number;
  radius: number;
}

/** Build an x-sorted spatial index of timeline events for O(log n) hit-tests. */
function buildSpatialIndex(
  timeEvents: TimeEvent[],
  eventSizes: Map<string, number>,
  width: number,
  height: number,
  scale: number,
  panX: number
): SpatialEntry[] {
  const centerY = height / 2;
  return timeEvents
    .map((event) => {
      const x = event.position * width * scale + panX;
      const radius = eventSizes.get(event.id) ?? EVENT_RADIUS_MIN;
      const yOffset = EVENT_OFFSET + event.stackIndex * EVENT_STACK_SPACING;
      const y = centerY - yOffset;
      return { event, x, y, radius };
    })
    .sort((a, b) => a.x - b.x);
}

function findNearestEvent(
  entries: SpatialEntry[],
  mouseX: number,
  mouseY: number
): TimeEvent | null {
  if (entries.length === 0) return null;
  const searchRadius = EVENT_RADIUS_MAX + EVENT_STACK_SPACING + 3;
  let left = 0;
  let right = entries.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (entries[mid].x < mouseX - searchRadius) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  let nearest: TimeEvent | null = null;
  let nearestDist = Infinity;
  for (let i = left; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.x > mouseX + searchRadius) break;
    const dist = Math.sqrt((mouseX - entry.x) ** 2 + (mouseY - entry.y) ** 2);
    if (dist <= entry.radius + 3 && dist < nearestDist) {
      nearestDist = dist;
      nearest = entry.event;
    }
  }
  return nearest;
}

export const TimelineView = memo(function TimelineView({
  nodes,
  className = '',
}: NodeTimelineRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [dateProperties, setDateProperties] = useState<DatePropertyConfig[]>(() => {
    const palette = getDateLanePalette();
    return [
      { property: 'create_date', label: 'Created', color: palette[0], visible: true, removable: false },
      { property: 'write_date', label: 'Modified', color: palette[1], visible: true, removable: false },
    ];
  });
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [transform, setTransform] = useState<TimelineTransform>({ panX: 0, scale: 1.0 });
  const [zoomPreset, setZoomPreset] = useState<'decade' | 'year' | 'semester' | 'quatrimester' | 'month' | 'custom'>('year');
  const [hoveredEvent, setHoveredEvent] = useState<TimeEvent | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TimeEvent | null>(null);
  const [cardPosition, setCardPosition] = useState<{ x: number; y: number; showOnLeft?: boolean } | null>(null);
  const [isDraggingViewZone, setIsDraggingViewZone] = useState(false);
  const [isDraggingHandle, setIsDraggingHandle] = useState<'left' | 'right' | null>(null);
  const [prevVisibleDays, setPrevVisibleDays] = useState<number>(365);
  const [markerOpacity, setMarkerOpacity] = useState<number>(1);
  
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef(transform);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, panX: 0 });
  const manualZoomRef = useRef(false);
  const markersRef = useRef<Array<{ x: number; date: Date; interval: number }>>([]);
  
  const { openNode, addSidebarCard } = useNavigationStore(
    useShallow((state) => ({ openNode: state.openNode, addSidebarCard: state.addSidebarCard })),
  );
  
  const { data: serverSettings } = useSettingsQuery();
  
  const currentZoomLevel = useMemo(() => getZoomLevelFromScale(transform.scale), [transform.scale]);
  
  // Load settings from cached TanStack Query data
  useEffect(() => {
    if (!serverSettings) return;
    const saved = serverSettings['timeline_date_properties'];
    if (saved) {
      if (Array.isArray(saved)) {
        setDateProperties(saved);
      }
    }
  }, [serverSettings]);
  
  // Save settings
  useEffect(() => {
    const timer = setTimeout(() => {
      setSetting('timeline_date_properties', dateProperties).catch(e => {
        console.error('Failed to save timeline_date_properties:', e);
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [dateProperties]);
  
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);
  
  // Calculate date range
  const dateRange = useMemo(() => {
    const dates: Date[] = [];
    nodes.forEach(node => {
      dateProperties.filter(p => p.visible).forEach(prop => {
        const dateStr = node[prop.property as keyof Node];
        if (dateStr && typeof dateStr === 'string') {
          const date = new Date(dateStr);
          if (!isNaN(date.getTime())) {
            dates.push(date);
          }
        }
      });
    });
    
    const eventRange = getDateRange(dates, 0.1);
    
    // Ensure minimum range of 2 years centered on today
    const today = new Date();
    const minRangeMs = 2 * 365 * 24 * 60 * 60 * 1000; // 2 years
    const currentRangeMs = eventRange.end.getTime() - eventRange.start.getTime();
    
    if (currentRangeMs < minRangeMs) {
      // Expand range to 2 years, centered on today
      const halfRange = minRangeMs / 2;
      return {
        start: new Date(today.getTime() - halfRange),
        end: new Date(today.getTime() + halfRange)
      };
    }
    
    return eventRange;
  }, [nodes, dateProperties]);
  
  // Generate time events
  const timeEvents = useMemo(() => {
    return generateTimeEvents(nodes, dateProperties, currentZoomLevel, dateRange.start, dateRange.end);
  }, [nodes, dateProperties, currentZoomLevel, dateRange]);
  
  // Calculate event sizes (normalized by node count)
  const eventSizes = useMemo(() => {
    if (timeEvents.length === 0) return new Map<string, number>();

    const minNodes = Math.min(...timeEvents.map(e => e.nodes.length));
    const maxNodes = Math.max(...timeEvents.map(e => e.nodes.length));
    const range = maxNodes - minNodes || 1;

    const sizes = new Map<string, number>();
    timeEvents.forEach(event => {
      const normalized = (event.nodes.length - minNodes) / range;
      const radius = EVENT_RADIUS_MIN + (normalized * (EVENT_RADIUS_MAX - EVENT_RADIUS_MIN));
      sizes.set(event.id, radius);
    });

    return sizes;
  }, [timeEvents]);

  // Spatial index for O(log n) event hit-testing.
  const spatialIndex = useMemo(
    () => buildSpatialIndex(timeEvents, eventSizes, dimensions.width, dimensions.height, transform.scale, transform.panX),
    [timeEvents, eventSizes, dimensions.width, dimensions.height, transform.scale, transform.panX]
  );
  
  // Initial zoom to year and center on today
  useEffect(() => {
    const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
    if (totalDays > 0) {
      const targetDays = 365;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, totalDays / targetDays));
      
      const today = new Date();
      let todayPosition = (today.getTime() - dateRange.start.getTime()) / (dateRange.end.getTime() - dateRange.start.getTime());
      todayPosition = Math.max(0, Math.min(1, todayPosition));
      const todayX = todayPosition * dimensions.width * newScale;
      const newPanX = dimensions.width / 2 - todayX;
      
      setTransform({ scale: newScale, panX: newPanX });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
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
        if (minimapRef.current) {
          const minimapWidth = minimapRef.current.getBoundingClientRect().width;
          minimapRef.current.width = minimapWidth * window.devicePixelRatio;
          minimapRef.current.height = MINIMAP_HEIGHT * window.devicePixelRatio;
          const ctx = minimapRef.current.getContext('2d');
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
  
  // Add native wheel event listener to prevent browser zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const handleNativeWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    
    canvas.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleNativeWheel);
  }, []);
  
  // Render timeline
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const result = rendererRef.drawMain(canvas, {
      dimensions,
      transform,
      dateRange,
      timeEvents,
      eventSizes,
      hoveredEvent,
      selectedEvent,
      markerOpacity,
    });

    markersRef.current = result.markers;
  }, [dimensions, transform, timeEvents, eventSizes, hoveredEvent, selectedEvent, dateRange, markerOpacity]);

  // Render minimap
  const renderMinimap = useCallback(() => {
    const canvas = minimapRef.current;
    if (!canvas) return;

    rendererRef.drawMinimap(canvas, {
      timeEvents,
      transform,
      mainWidth: dimensions.width,
    });
  }, [dimensions, transform, timeEvents]);
  
  // Render minimap whenever the data or viewport changes.
  useEffect(() => {
    renderMinimap();
  }, [renderMinimap]);

  // Render main canvas whenever dependencies change.
  useEffect(() => {
    render();
  }, [render]);

  // Fade markers briefly when the zoom level jumps enough to change marker density.
  useEffect(() => {
    const totalMs = dateRange.end.getTime() - dateRange.start.getTime();
    const totalDays = totalMs / (24 * 60 * 60 * 1000);
    if (totalDays <= 0) return;
    const visibleDays = totalDays / transform.scale;
    const daysDiff = Math.abs(visibleDays - prevVisibleDays);
    const thresholdChange = Math.max(10, prevVisibleDays * 0.3);

    if (daysDiff > thresholdChange && prevVisibleDays !== 365) {
      setPrevVisibleDays(visibleDays);
      setMarkerOpacity(0.3);
    } else if (markerOpacity < 1) {
      setMarkerOpacity((prev) => Math.min(1, prev + 0.2));
    }
  }, [dimensions, transform, dateRange, prevVisibleDays, markerOpacity]);
  
  // Mouse handlers
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const hovered = findNearestEvent(spatialIndex, mouseX, mouseY);

    setHoveredEvent(hovered || null);
  }, [spatialIndex]);
  
  const handleClick = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current) return;
    
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    // Check if clicked on a time marker
    const clickedMarker = markersRef.current.find(marker => {
      return Math.abs(mouseX - marker.x) < 15 && mouseY >= centerY - 10 && mouseY <= centerY + 25;
    });
    
    if (clickedMarker) {
      const date = clickedMarker.date;
      const interval = clickedMarker.interval;
      
      try {
        // Determine if it's a day, month, or year based on interval
        if (interval === 24 * 60 * 60 * 1000) {
          // Daily marker
          const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          const dailyNode = await nodesApi.getOrCreateDaily(formattedDate);
          if (e.shiftKey) {
            addSidebarCard(dailyNode.id, 'page');
          } else {
            openNode(dailyNode.id);
          }
        } else if (interval >= 30 * 24 * 60 * 60 * 1000 && interval <= 90 * 24 * 60 * 60 * 1000) {
          // Monthly marker (30 days or 3 months)
          const monthlyNode = await nodesApi.getOrCreateMonthly(date.getFullYear(), date.getMonth() + 1);
          if (e.shiftKey) {
            addSidebarCard(monthlyNode.id, 'page');
          } else {
            openNode(monthlyNode.id);
          }
        } else if (interval >= 365 * 24 * 60 * 60 * 1000) {
          // Yearly marker
          const yearlyNode = await nodesApi.getOrCreateYearly(date.getFullYear());
          if (e.shiftKey) {
            addSidebarCard(yearlyNode.id, 'page');
          } else {
            openNode(yearlyNode.id);
          }
        }
        return; // Don't check for events if marker was clicked
      } catch (error) {
        console.error('Failed to open date page:', error);
      }
    }
    
    // Check if clicked on an event
    const clicked = findNearestEvent(spatialIndex, mouseX, mouseY);

    if (clicked) {
      setSelectedEvent(clicked);
      const x = clicked.position * dimensions.width * transform.scale + transform.panX;
      const yOffset = EVENT_OFFSET + (clicked.stackIndex * EVENT_STACK_SPACING);
      const y = centerY - yOffset;
      
      // Calculate position based on available space
      const cardWidth = 400; // max-width from CSS
      const clickedX = x + rect.left;
      const viewportWidth = window.innerWidth;
      
      // Check if there's enough space on the right
      const spaceOnRight = viewportWidth - clickedX;
      const showOnLeft = spaceOnRight < cardWidth + 30; // 30px margin
      
      setCardPosition({ 
        x: clickedX, 
        y: y + rect.top,
        showOnLeft 
      });
    } else {
      setSelectedEvent(null);
      setCardPosition(null);
    }
  }, [spatialIndex, dimensions.width, dimensions.height, transform.scale, transform.panX, openNode, addSidebarCard]);
  
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, panX: transform.panX };
    // Hide panel when starting to pan
    setSelectedEvent(null);
    setCardPosition(null);
  }, [transform.panX]);
  
  const handleMouseMoveCanvas = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    handleMouseMove(e);
    
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      setTransform(prev => ({ ...prev, panX: panStartRef.current.panX + dx }));
    }
  }, [handleMouseMove]);
  
  // Minimap handlers
  const handleMinimapMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = minimapRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const minimapWidth = rect.width;
    const { scale, panX } = transform;
    const mainWidth = dimensions.width;
    const viewWidth = (mainWidth / scale) * (minimapWidth / mainWidth);
    const viewX = (-panX / scale) * (minimapWidth / mainWidth);
    
    const handleWidth = 8;
    
    // Check left handle
    if (Math.abs(mouseX - viewX) < handleWidth) {
      setIsDraggingHandle('left');
      return;
    }
    
    // Check right handle
    if (Math.abs(mouseX - (viewX + viewWidth)) < handleWidth) {
      setIsDraggingHandle('right');
      return;
    }
    
    // Check view zone
    if (mouseX >= viewX && mouseX <= viewX + viewWidth) {
      setIsDraggingViewZone(true);
      panStartRef.current = { x: mouseX, panX: transform.panX };
      return;
    }
    
    // Click outside - jump to position
    const targetX = mouseX * (mainWidth / minimapWidth);
    const newPanX = -targetX * scale + mainWidth / 2;
    setTransform(prev => ({ ...prev, panX: newPanX }));
  }, [dimensions, transform]);
  
  const handleMinimapMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = minimapRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const minimapWidth = rect.width;
    const mainWidth = dimensions.width;
    const { scale } = transform;
    
    if (isDraggingHandle) {
      // Calculate current view zone in minimap coordinates
      const viewStartRatio = -transform.panX / (mainWidth * scale);
      const viewEndRatio = viewStartRatio + (1 / scale);
      const viewStartX = viewStartRatio * minimapWidth;
      const viewEndX = viewEndRatio * minimapWidth;
      
      if (isDraggingHandle === 'left') {
        // Dragging left handle - adjust start of view (affects both panX and scale)
        const newViewStartX = Math.max(0, Math.min(mouseX, viewEndX - 20));
        const newViewStartRatio = newViewStartX / minimapWidth;
        const newViewEndRatio = viewEndRatio;
        const newViewRatio = newViewEndRatio - newViewStartRatio;
        
        const targetScale = 1 / newViewRatio;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, targetScale));
        
        // Only update if scale actually changed (not clamped)
        if (newScale !== transform.scale) {
          const newPanX = -newViewStartRatio * mainWidth * newScale;
          setTransform({ scale: newScale, panX: newPanX });
        }
      } else if (isDraggingHandle === 'right') {
        // Dragging right handle - adjust end of view (affects scale, keeps left edge fixed)
        const newViewEndX = Math.max(viewStartX + 20, Math.min(mouseX, minimapWidth));
        const newViewEndRatio = newViewEndX / minimapWidth;
        const newViewStartRatio = viewStartRatio;
        const newViewRatio = newViewEndRatio - newViewStartRatio;
        
        const targetScale = 1 / newViewRatio;
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, targetScale));
        
        // Only update if scale actually changed (not clamped)
        if (newScale !== transform.scale) {
          const newPanX = -newViewStartRatio * mainWidth * newScale;
          setTransform({ scale: newScale, panX: newPanX });
        }
      }
    } else if (isDraggingViewZone) {
      const dx = mouseX - panStartRef.current.x;
      const actualDx = dx * (mainWidth / minimapWidth);
      const newPanX = panStartRef.current.panX - actualDx * scale;
      setTransform(prev => ({ ...prev, panX: newPanX }));
    }
  }, [dimensions, transform, isDraggingHandle, isDraggingViewZone]);
  
  const handleMinimapMouseUp = useCallback(() => {
    setIsDraggingViewZone(false);
    setIsDraggingHandle(null);
  }, []);
  
  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
  }, []);
  
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    // Close panel when scrolling
    if (selectedEvent) {
      setSelectedEvent(null);
      setCardPosition(null);
    }
    
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      
      const mouseX = e.clientX - rect.left;
      const delta = -e.deltaY;
      
      const zoomSpeed = Math.abs(e.deltaY) > 50 ? ZOOM_SPEED_WHEEL : ZOOM_SPEED_PINCH;
      const zoomFactor = 1 + delta * zoomSpeed;
      
      setTransform(prev => {
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * zoomFactor));
        const scaleRatio = newScale / prev.scale;
        const newPanX = mouseX - (mouseX - prev.panX) * scaleRatio;
        return { scale: newScale, panX: newPanX };
      });
      
      setZoomPreset('custom');
    } else {
      e.preventDefault();
      const delta = -e.deltaY;
      setTransform(prev => ({ ...prev, panX: prev.panX + delta }));
    }
  }, [selectedEvent]);
  
  const calculateScaleForDays = useCallback((targetDays: number): number => {
    const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
    if (totalDays <= 0) return 1.0;
    return totalDays / targetDays;
  }, [dateRange]);
  
  const zoomToPreset = useCallback((preset: 'decade' | 'year' | 'semester' | 'quatrimester' | 'month') => {
    const targetDays = 
      preset === 'decade' ? 3650 :
      preset === 'year' ? 365 :
      preset === 'semester' ? 180 :
      preset === 'quatrimester' ? 120 :
      30;  // month - show exactly 30 days
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, calculateScaleForDays(targetDays)));
    
    const today = new Date();
    let todayPosition = (today.getTime() - dateRange.start.getTime()) / (dateRange.end.getTime() - dateRange.start.getTime());
    todayPosition = Math.max(0, Math.min(1, todayPosition));
    const todayX = todayPosition * dimensions.width * newScale;
    const newPanX = dimensions.width / 2 - todayX;
    
    manualZoomRef.current = true;
    setTransform({ scale: newScale, panX: newPanX });
    setZoomPreset(preset);
  }, [calculateScaleForDays, dateRange, dimensions.width]);
  
  // Auto-detect zoom preset based on current scale (debounced to avoid flickering)
  useEffect(() => {
    // Skip auto-detection if zoom was manually set via preset button
    if (manualZoomRef.current) {
      manualZoomRef.current = false;
      return;
    }
    
    const timeout = setTimeout(() => {
      const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
      if (totalDays <= 0) return;
      
      const visibleDays = totalDays / transform.scale;
      
      // Find the closest preset based on visible days
      const presets = [
        { name: 'decade' as const, targetDays: 3650 },
        { name: 'year' as const, targetDays: 365 },
        { name: 'semester' as const, targetDays: 180 },
        { name: 'quatrimester' as const, targetDays: 120 },
        { name: 'month' as const, targetDays: 30 },
      ];
      
      let closestPreset: 'decade' | 'year' | 'semester' | 'quatrimester' | 'month' | 'custom' = 'custom';
      let minDiff = Infinity;
      
      for (const preset of presets) {
        const diff = Math.abs(visibleDays - preset.targetDays);
        if (diff < minDiff) {
          minDiff = diff;
          closestPreset = preset.name;
        }
      }
      
      // Only snap to preset if we're within 25% of target days (increased threshold for stability)
      const threshold = 0.25;
      const targetDays = presets.find(p => p.name === closestPreset)?.targetDays ?? 365;
      const detectedPreset = (minDiff / targetDays <= threshold) ? closestPreset : 'custom';
      
      // Only update if actually different to avoid unnecessary re-renders
      setZoomPreset(prev => prev === detectedPreset ? prev : detectedPreset);
    }, 100); // Debounce by 100ms
    
    return () => clearTimeout(timeout);
  }, [transform.scale, dateRange]);
  
  const zoomPresetOptions = [
    { value: 'decade', label: 'Decade', icon: "mdi mdi-alpha-d" },
    { value: 'year', label: 'Year', icon: "mdi mdi-alpha-y" },
    { value: 'semester', label: 'Semester', icon: "mdi mdi-alpha-s" },
    { value: 'quatrimester', label: 'Quatrimester', icon: "mdi mdi-alpha-q" },
    { value: 'month', label: 'Month', icon: "mdi mdi-alpha-m" },
  ];
  
  if (timeEvents.length === 0) {
    return (
      <div className={`node-timeline-renderer node-timeline-renderer--empty ${className}`}>
        <div className="node-timeline-renderer__empty-state">
          <CalendarIcon size="lg" color="var(--color-on-surface-variant)" />
          <div className="node-timeline-renderer__empty-title">No timeline events yet</div>
          <div className="node-timeline-renderer__empty-subtitle">
            Add a date property to items to see them on the timeline.
          </div>
        </div>
      </div>
    );
  }
  
  return (
    <div className={`node-timeline-renderer ${className}`} ref={containerRef}>
      <div className="node-timeline-renderer__controls">
        <div className="node-timeline-renderer__controls-left">
          <ButtonWithPanel
            icon={"mdi mdi-calendar-range"}
            size="sm"
            panelPosition="right"
          >
            <DatePropertiesPanel
              properties={dateProperties}
              onChange={setDateProperties}
            />
          </ButtonWithPanel>
        </div>
      </div>
      
      <canvas
        ref={canvasRef}
        className="node-timeline-renderer__canvas"
        onMouseMove={handleMouseMoveCanvas}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onWheel={handleWheel}
      />
      
      <div className="node-timeline-renderer__minimap-container">
        <div className="node-timeline-renderer__minimap-controls">
          <SelectionButton
            options={zoomPresetOptions}
            value={zoomPreset === 'custom' ? '' : zoomPreset}
            onChange={(val) => zoomToPreset(val as any)}
            size="sm"
          />
        </div>
        
        <canvas
          ref={minimapRef}
          className="node-timeline-renderer__minimap"
          onMouseDown={handleMinimapMouseDown}
          onMouseMove={handleMinimapMouseMove}
          onMouseUp={handleMinimapMouseUp}
          onMouseLeave={handleMinimapMouseUp}
        />
      </div>
      
      {selectedEvent && cardPosition && (
        <Card
          elevation="high"
          variant="default"
          padding={false}
          showCloseButton
          onClose={() => {
            setSelectedEvent(null);
            setCardPosition(null);
          }}
          className="timeline-event-card"
          style={{
            position: 'fixed',
            left: cardPosition.showOnLeft ? undefined : cardPosition.x + 15,
            right: cardPosition.showOnLeft ? window.innerWidth - cardPosition.x + 15 : undefined,
            top: cardPosition.y - 20,
            zIndex: 'var(--z-1000)',
          }}
        >
          <div className="timeline-event-card__header">
            <span className="timeline-event-card__title">{selectedEvent.propertyLabel}</span>
          </div>
          <div className="timeline-event-card__content">
            <NodeCollection
              nodes={selectedEvent.nodes}
              viewMode="list"
              editable={false}
              showClasses={true}
              pagesOnly={true}
              onNodeClick={(node) => openNode(node.id)}
              onNodeShiftClick={(node) => addSidebarCard(node.id, node.is_page ? 'page' : 'block')}
            />
          </div>
        </Card>
      )}
    </div>
  );
});

registerView({
  id: 'timeline',
  label: 'Timeline',
  icon: 'mdi mdi-timeline-clock-outline',
  component: TimelineView,
  capabilities: { errorBoundary: true },
});
