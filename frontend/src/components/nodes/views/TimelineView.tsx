/**
 * TimelineView Component
 * 
 * Displays timeline with time events (date property occurrences).
 * Each event is rendered as a NodeCircle, stacked if multiple events at same time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { setSetting } from '@/api/databases';
import { useSettingsQuery } from '@/hooks/useSettings';
import * as nodesApi from '@/api/nodes';
import { useAppStore } from '@/stores';
import type { Node } from '@/types';
import type { TimeEvent, DatePropertyConfig, TimelineTransform, NodeTimelineRendererProps } from './timelineTypes';
import { mdiCalendarRange, mdiAlphaD, mdiAlphaY, mdiAlphaS, mdiAlphaQ, mdiAlphaM } from '@mdi/js';
import { Card } from '../../core/Card';
import { ButtonWithPanel } from '../../core/ButtonWithPanel';
import { SelectionButton } from '../../core/SelectionButton';
import { DatePropertiesPanel } from './DatePropertiesPanel';
import { NodeCollection } from '../../nodes/NodeCollection';
import { getDateRange } from './timelineUtils/dateUtils';
import { generateTimeEvents } from './timelineUtils/timeEvents';
import { getZoomLevelFromScale } from './timelineUtils/zoomLevels';
import './TimelineView.css';
import './DatePropertiesPanel.css';

const EVENT_RADIUS_MIN = 4;
const EVENT_RADIUS_MAX = 12;
const EVENT_STACK_SPACING = 18;
const EVENT_OFFSET = 25;
const MINIMAP_HEIGHT = 60;

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;
const ZOOM_SPEED_WHEEL = 0.002;
const ZOOM_SPEED_PINCH = 0.01;

export function TimelineView({
  nodes,
  className = '',
}: NodeTimelineRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  
  const [dateProperties, setDateProperties] = useState<DatePropertyConfig[]>([
    { property: 'create_date', label: 'Created', color: '#6366f1', visible: true, removable: false },
    { property: 'write_date', label: 'Modified', color: '#8b5cf6', visible: true, removable: false },
  ]);
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
  
  const { openNode, addSidebarCard } = useAppStore();
  
  const { data: serverSettings } = useSettingsQuery();
  
  const currentZoomLevel = useMemo(() => getZoomLevelFromScale(transform.scale), [transform.scale]);
  
  // Load settings from cached TanStack Query data
  useEffect(() => {
    if (!serverSettings) return;
    const saved = serverSettings['timeline_date_properties'];
    if (saved) {
      try {
        // Handle both formats: raw object (new) or JSON string (legacy)
        const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
        if (Array.isArray(parsed)) {
          setDateProperties(parsed);
        }
      } catch (e) {
        console.error('Failed to parse timeline_date_properties:', e);
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
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const { width, height } = dimensions;
    const { panX, scale } = transform;
    const centerY = height / 2;
    
    ctx.clearRect(0, 0, width, height);
    
    // Draw time markers FIRST (behind timeline)
    const textColor = getComputedStyle(canvas).getPropertyValue('--color-on-surface-variant').trim() || '#a3a3a3';
    ctx.fillStyle = textColor;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    
    const totalMs = dateRange.end.getTime() - dateRange.start.getTime();
    
    // Calculate visible days based on scale directly
    // When scale < 1, we're viewing more than the dateRange
    // The visible window is: totalDays / scale
    const totalDays = totalMs / (24 * 60 * 60 * 1000);
    const visibleDays = totalDays / scale;
    
    // Calculate visible date range for marker positioning
    const visibleStartRatio = Math.max(0, -panX / (width * scale));
    const visibleEndRatio = Math.min(1, (-panX + width) / (width * scale));
    
    const visibleStart = new Date(dateRange.start.getTime() + visibleStartRatio * totalMs);
    const visibleEnd = new Date(dateRange.start.getTime() + visibleEndRatio * totalMs);
    
    // Fade markers when zoom changes significantly (but always use current visibleDays for calculations)
    const daysDiff = Math.abs(visibleDays - prevVisibleDays);
    const thresholdChange = Math.max(10, prevVisibleDays * 0.3);  // At least 10 days or 30% change
    
    if (daysDiff > thresholdChange && prevVisibleDays !== 365) {  // Skip initial default value
      if (markerOpacity === 1) {
        setMarkerOpacity(0.3);
      }
      setPrevVisibleDays(visibleDays);
    } else if (markerOpacity < 1) {
      setMarkerOpacity(Math.min(1, markerOpacity + 0.2));
    }
    
    let markerInterval: number;
    let dateFormat: (date: Date) => string;
    
    // Choose interval based on how many days are visible (always use current value)
    if (visibleDays <= 10) {
      markerInterval = 24 * 60 * 60 * 1000; // 1 day
      dateFormat = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else if (visibleDays <= 90) {
      markerInterval = 7 * 24 * 60 * 60 * 1000; // 1 week
      dateFormat = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } else if (visibleDays <= 365) {
      markerInterval = 30 * 24 * 60 * 60 * 1000; // ~1 month
      dateFormat = (d) => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    } else if (visibleDays <= 1460) {
      markerInterval = 90 * 24 * 60 * 60 * 1000; // ~3 months
      dateFormat = (d) => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    } else if (visibleDays <= 5475) {
      markerInterval = 365 * 24 * 60 * 60 * 1000; // 1 year
      dateFormat = (d) => d.getFullYear().toString();
    } else {
      markerInterval = 3650 * 24 * 60 * 60 * 1000; // 10 years
      dateFormat = (d) => d.getFullYear().toString();
    }
    
    // Extend visible range a bit to catch markers just outside the view
    const extendedStart = new Date(visibleStart.getTime() - markerInterval);
    const extendedEnd = new Date(visibleEnd.getTime() + markerInterval);
    
    // Store markers for click detection
    const markers: Array<{ x: number; date: Date; interval: number }> = [];
    
    // Draw markers
    const firstMarker = new Date(Math.floor(extendedStart.getTime() / markerInterval) * markerInterval);
    for (let markerDate = firstMarker; markerDate <= extendedEnd; markerDate = new Date(markerDate.getTime() + markerInterval)) {
      const markerPos = (markerDate.getTime() - dateRange.start.getTime()) / totalMs;
      const x = markerPos * width * scale + panX;
      
      if (x >= -50 && x <= width + 50) {
        // Store marker for click detection
        markers.push({ x, date: new Date(markerDate), interval: markerInterval });
        // Tick mark
        ctx.globalAlpha = markerOpacity;
        ctx.strokeStyle = textColor + '80';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, centerY - 5);
        ctx.lineTo(x, centerY + 5);
        ctx.stroke();
        
        // Label
        ctx.fillStyle = textColor;
        ctx.fillText(dateFormat(markerDate), x, centerY + 10);
        ctx.globalAlpha = 1;
      }
    }
    
    // Update markers ref for click detection
    markersRef.current = markers;
    
    // Draw timeline line
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--color-outline').trim() || '#a3a3a3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
    
    // Draw time events
    timeEvents.forEach(event => {
      const x = event.position * width * scale + panX;
      if (x < -50 || x > width + 50) return;
      
      const radius = eventSizes.get(event.id) || EVENT_RADIUS_MIN;
      const yOffset = EVENT_OFFSET + (event.stackIndex * EVENT_STACK_SPACING);
      const y = centerY - yOffset;
      
      const isHovered = hoveredEvent?.id === event.id;
      const isSelected = selectedEvent?.id === event.id;
      
      // Connector line
      ctx.strokeStyle = event.color + '40';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, centerY);
      ctx.stroke();
      
      // Event circle
      if (isSelected || isHovered) {
        ctx.fillStyle = event.color + '40';
        ctx.beginPath();
        ctx.arc(x, y, radius + 4, 0, 2 * Math.PI);
        ctx.fill();
      }
      
      ctx.fillStyle = event.color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fill();
    });
  }, [dimensions, transform, timeEvents, eventSizes, hoveredEvent, selectedEvent, dateRange, markerOpacity, prevVisibleDays]);
  
  // Render minimap
  const renderMinimap = useCallback(() => {
    const canvas = minimapRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const width = canvas.width / window.devicePixelRatio;
    const height = MINIMAP_HEIGHT;
    const { panX, scale } = transform;
    const mainWidth = dimensions.width;
    
    ctx.clearRect(0, 0, width, height);
    
    // Get CSS variables
    const bgColor = getComputedStyle(canvas).getPropertyValue('--color-surface-container-low').trim() || '#262626';
    const lineColor = getComputedStyle(canvas).getPropertyValue('--color-outline-variant').trim() || '#444';
    const accentColor = getComputedStyle(canvas).getPropertyValue('--color-primary').trim() || '#e5e5e5';
    
    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);
    
    // Timeline line
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    
    // Events (simplified)
    timeEvents.forEach(event => {
      const x = event.position * width;
      ctx.fillStyle = event.color;
      ctx.fillRect(x - 1, height / 2 - 8, 2, 16);
    });
    
    // View zone (clamped to 0-width)
    // Convert main canvas pan/scale to minimap coordinates
    let viewWidth = (mainWidth / scale) * (width / mainWidth);
    let viewX = (-panX / scale) * (width / mainWidth);
    
    // Clamp view zone to minimap bounds
    if (viewX < 0) {
      viewWidth += viewX;
      viewX = 0;
    }
    if (viewX + viewWidth > width) {
      viewWidth = width - viewX;
    }
    viewWidth = Math.max(20, viewWidth); // Ensure minimum visible width
    
    ctx.strokeStyle = accentColor;
    ctx.fillStyle = accentColor + '44';
    ctx.lineWidth = 2;
    ctx.fillRect(viewX, 0, viewWidth, height);
    ctx.strokeRect(viewX, 0, viewWidth, height);
    
    // Resize handles (always visible)
    const handleWidth = 8;
    ctx.fillStyle = accentColor;
    const leftHandleX = Math.max(handleWidth / 2, viewX);
    const rightHandleX = Math.min(width - handleWidth / 2, viewX + viewWidth);
    ctx.fillRect(leftHandleX - handleWidth / 2, height / 2 - 15, handleWidth, 30);
    ctx.fillRect(rightHandleX - handleWidth / 2, height / 2 - 15, handleWidth, 30);
  }, [dimensions, transform, timeEvents]);
  
  // Animation loop for minimap
  useEffect(() => {
    renderMinimap();
  }, [renderMinimap]);
  
  // Animation loop
  useEffect(() => {
    const loop = () => {
      render();
      animationRef.current = requestAnimationFrame(loop);
    };
    animationRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationRef.current);
  }, [render]);
  
  // Mouse handlers
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
    const hovered = timeEvents.find(event => {
      const x = event.position * dimensions.width * transform.scale + transform.panX;
      const radius = eventSizes.get(event.id) || EVENT_RADIUS_MIN;
      const yOffset = EVENT_OFFSET + (event.stackIndex * EVENT_STACK_SPACING);
      const y = centerY - yOffset;
      const dist = Math.sqrt((mouseX - x) ** 2 + (mouseY - y) ** 2);
      return dist < radius + 3;
    });
    
    setHoveredEvent(hovered || null);
  }, [dimensions, transform, timeEvents, eventSizes]);
  
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
    const clicked = timeEvents.find(event => {
      const x = event.position * dimensions.width * transform.scale + transform.panX;
      const radius = eventSizes.get(event.id) || EVENT_RADIUS_MIN;
      const yOffset = EVENT_OFFSET + (event.stackIndex * EVENT_STACK_SPACING);
      const y = centerY - yOffset;
      const dist = Math.sqrt((mouseX - x) ** 2 + (mouseY - y) ** 2);
      return dist < radius + 3;
    });
    
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
  }, [dimensions, transform, timeEvents, eventSizes, openNode, addSidebarCard]);
  
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
    { value: 'decade', label: 'Decade', icon: mdiAlphaD },
    { value: 'year', label: 'Year', icon: mdiAlphaY },
    { value: 'semester', label: 'Semester', icon: mdiAlphaS },
    { value: 'quatrimester', label: 'Quatrimester', icon: mdiAlphaQ },
    { value: 'month', label: 'Month', icon: mdiAlphaM },
  ];
  
  if (timeEvents.length === 0) {
    return (
      <div className={`node-timeline-renderer node-timeline-renderer--empty ${className}`}>
        <div className="node-timeline-renderer__empty-message">
          No timeline events to display
        </div>
      </div>
    );
  }
  
  return (
    <div className={`node-timeline-renderer ${className}`} ref={containerRef}>
      <div className="node-timeline-renderer__controls">
        <div className="node-timeline-renderer__controls-left">
          <ButtonWithPanel
            icon={mdiCalendarRange}
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
            zIndex: 1000,
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
              onNodeClick={(node) => openNode(node.id)}
              onNodeShiftClick={(node) => addSidebarCard(node.id, node.is_page ? 'page' : 'block')}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
