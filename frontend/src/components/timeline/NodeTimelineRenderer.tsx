/**
 * NodeTimelineRenderer Component
 * 
 * Displays timeline with time events (date property occurrences).
 * Each event is rendered as a NodeCircle, stacked if multiple events at same time.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { getSettings, setSetting } from '@/api/databases';
import type { Node } from '@/types';
import type { TimeEvent, DatePropertyConfig, TimelineTransform, NodeTimelineRendererProps } from './types';
import { mdiCalendarRange, mdiAlphaD, mdiAlphaY, mdiAlphaS, mdiAlphaQ, mdiAlphaM, mdiAlphaW } from '@mdi/js';
import { Button } from '../core/Button';
import { Card } from '../core/Card';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { SelectionButton } from '../core/SelectionButton';
import { ToggleSwitch } from '../core/ToggleSwitch';
import { DatePropertiesPanel } from './DatePropertiesPanel';
import { NodeCollection } from '../nodes/NodeCollection';
import { getDateRange } from './utils/dateUtils';
import { generateTimeEvents } from './utils/timeEvents';
import { getZoomLevelFromScale } from './utils/zoomLevels';
import './NodeTimelineRenderer.css';
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

export function NodeTimelineRenderer({
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
  const [zoomPreset, setZoomPreset] = useState<'decade' | 'year' | 'semester' | 'quatrimester' | 'month' | 'week' | 'custom'>('year');
  const [orientation, setOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
  const [hoveredEvent, setHoveredEvent] = useState<TimeEvent | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TimeEvent | null>(null);
  const [cardPosition, setCardPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDraggingViewZone, setIsDraggingViewZone] = useState(false);
  const [isDraggingHandle, setIsDraggingHandle] = useState<'left' | 'right' | null>(null);
  
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef(transform);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, panX: 0 });
  
  const currentZoomLevel = useMemo(() => getZoomLevelFromScale(transform.scale), [transform.scale]);
  
  // Load settings
  useEffect(() => {
    getSettings().then(settings => {
      const saved = settings['timeline_date_properties'];
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            setDateProperties(parsed);
          }
        } catch (e) {
          console.error('Failed to parse timeline_date_properties:', e);
        }
      }
    });
  }, []);
  
  // Save settings
  useEffect(() => {
    const timer = setTimeout(() => {
      setSetting('timeline_date_properties', JSON.stringify(dateProperties)).catch(e => {
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
    return getDateRange(dates, 0.1);
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
      }
    };
    
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
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
    
    // Draw timeline line
    ctx.strokeStyle = '#666';
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
  }, [dimensions, transform, timeEvents, eventSizes, hoveredEvent, selectedEvent]);
  
  // Render minimap
  const renderMinimap = useCallback(() => {
    const canvas = minimapRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const width = dimensions.width;
    const height = MINIMAP_HEIGHT;
    const { panX, scale } = transform;
    
    ctx.clearRect(0, 0, width, height);
    
    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);
    
    // Timeline line
    ctx.strokeStyle = '#444';
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
    const viewWidth = width / scale;
    const viewX = Math.max(0, Math.min(width - viewWidth, -panX / scale));
    
    ctx.strokeStyle = '#6366f1';
    ctx.fillStyle = '#6366f144';
    ctx.lineWidth = 2;
    ctx.fillRect(viewX, 0, viewWidth, height);
    ctx.strokeRect(viewX, 0, viewWidth, height);
    
    // Resize handles
    const handleWidth = 8;
    ctx.fillStyle = '#6366f1';
    ctx.fillRect(viewX - handleWidth / 2, height / 2 - 15, handleWidth, 30);
    ctx.fillRect(viewX + viewWidth - handleWidth / 2, height / 2 - 15, handleWidth, 30);
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
  
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanningRef.current) return;
    
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const centerY = dimensions.height / 2;
    
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
      setCardPosition({ x: x + rect.left, y: y + rect.top });
    } else {
      setSelectedEvent(null);
      setCardPosition(null);
    }
  }, [dimensions, transform, timeEvents, eventSizes]);
  
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX, panX: transform.panX };
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
    const { scale, panX } = transform;
    const viewWidth = dimensions.width / scale;
    const viewX = -panX / scale;
    
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
    const targetX = mouseX;
    const newPanX = -targetX * scale + dimensions.width / 2;
    setTransform(prev => ({ ...prev, panX: newPanX }));
  }, [dimensions, transform]);
  
  const handleMinimapMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = minimapRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const mouseX = e.clientX - rect.left;
    const { scale } = transform;
    
    if (isDraggingHandle) {
      const viewX = -transform.panX / scale;
      const viewWidth = dimensions.width / scale;
      
      if (isDraggingHandle === 'left') {
        // Dragging left handle - change scale and panX
        const newViewX = Math.max(0, Math.min(mouseX, viewX + viewWidth - 20));
        const newViewWidth = (viewX + viewWidth) - newViewX;
        const newScale = dimensions.width / newViewWidth;
        const clampedScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        const newPanX = -newViewX * clampedScale;
        setTransform({ scale: clampedScale, panX: newPanX });
      } else if (isDraggingHandle === 'right') {
        // Dragging right handle - change scale
        const newViewWidth = Math.max(20, mouseX - viewX);
        const newScale = dimensions.width / newViewWidth;
        const clampedScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
        setTransform(prev => ({ ...prev, scale: clampedScale }));
      }
      setZoomPreset('custom');
    } else if (isDraggingViewZone) {
      const dx = mouseX - panStartRef.current.x;
      const newPanX = panStartRef.current.panX - dx * scale;
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
  }, []);
  
  const calculateScaleForDays = useCallback((targetDays: number): number => {
    const totalDays = (dateRange.end.getTime() - dateRange.start.getTime()) / (1000 * 60 * 60 * 24);
    if (totalDays <= 0) return 1.0;
    return totalDays / targetDays;
  }, [dateRange]);
  
  const zoomToPreset = useCallback((preset: 'decade' | 'year' | 'semester' | 'quatrimester' | 'month' | 'week') => {
    const targetDays = 
      preset === 'decade' ? 3650 :
      preset === 'year' ? 365 :
      preset === 'semester' ? 180 :
      preset === 'quatrimester' ? 120 :
      preset === 'month' ? 30 :
      7;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, calculateScaleForDays(targetDays)));
    
    const today = new Date();
    let todayPosition = (today.getTime() - dateRange.start.getTime()) / (dateRange.end.getTime() - dateRange.start.getTime());
    todayPosition = Math.max(0, Math.min(1, todayPosition));
    const todayX = todayPosition * dimensions.width * newScale;
    const newPanX = dimensions.width / 2 - todayX;
    
    setTransform({ scale: newScale, panX: newPanX });
    setZoomPreset(preset);
  }, [calculateScaleForDays, dateRange, dimensions.width]);
  
  const zoomPresetOptions = [
    { value: 'decade', label: 'Decade', icon: mdiAlphaD },
    { value: 'year', label: 'Year', icon: mdiAlphaY },
    { value: 'semester', label: 'Semester', icon: mdiAlphaS },
    { value: 'quatrimester', label: 'Quatrimester', icon: mdiAlphaQ },
    { value: 'month', label: 'Month', icon: mdiAlphaM },
    { value: 'week', label: 'Week', icon: mdiAlphaW },
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
        onMouseMove={handleMouseMoveCanvas}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onWheel={handleWheel}
      />
      
      <canvas
        ref={minimapRef}
        className="node-timeline-renderer__minimap"
        width={dimensions.width}
        height={MINIMAP_HEIGHT}
        onMouseDown={handleMinimapMouseDown}
        onMouseMove={handleMinimapMouseMove}
        onMouseUp={handleMinimapMouseUp}
        onMouseLeave={handleMinimapMouseUp}
      />
      
      {selectedEvent && cardPosition && (
        <Card
          elevation="high"
          padding={false}
          showCloseButton
          onClose={() => {
            setSelectedEvent(null);
            setCardPosition(null);
          }}
          className="timeline-event-card"
          style={{
            position: 'fixed',
            left: cardPosition.x + 15,
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
            />
          </div>
        </Card>
      )}
    </div>
  );
}
