/**
 * Performance Instrumentation Utilities
 * 
 * Tools for measuring and monitoring render performance in Notees.
 * These utilities help identify performance bottlenecks and verify optimizations.
 * 
 * Metrics tracked:
 * - Time to first node render
 * - Time to focused view ready
 * - Node count vs render cost
 * - Component render frequency
 * 
 * Usage:
 * ```tsx
 * // In NodeView
 * const { markStart, markEnd, measure } = usePerformanceMarks('NodeView');
 * 
 * useEffect(() => {
 *   markStart('load');
 *   return () => markEnd('load');
 * }, []);
 * ```
 */

// ==================== Types ====================

export interface PerformanceMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export interface RenderMetric {
  componentName: string;
  renderCount: number;
  totalDuration: number;
  avgDuration: number;
  lastRenderTime: number;
}

export interface NodeLoadMetric {
  nodeId: number;
  loadStartTime: number;
  contentReadyTime?: number;
  childrenReadyTime?: number;
  totalDuration?: number;
}

export interface PerformanceGauges {
  /** Current number of mounted NodeView components */
  mountedNodeViews: number;
  /** Peak NodeView count during session */
  peakNodeViews: number;
  /** Current number of rendered Block components */
  mountedBlocks: number;
  /** Peak Block count during session */
  peakBlocks: number;
  /** Time to focused view ready (ms) */
  lastFocusedViewReadyMs: number | null;
  /** Average focused view load time */
  avgFocusedViewReadyMs: number;
  /** Focused view load count (for averaging) */
  focusedViewLoadCount: number;
}

// ==================== Performance Store ====================

class PerformanceStore {
  private metrics: Map<string, PerformanceMetric> = new Map();
  private renderMetrics: Map<string, RenderMetric> = new Map();
  private nodeLoadMetrics: Map<number, NodeLoadMetric> = new Map();
  private enabled: boolean = import.meta.env?.DEV ?? false;
  
  // Gauges for Phase 6 instrumentation
  private gauges: PerformanceGauges = {
    mountedNodeViews: 0,
    peakNodeViews: 0,
    mountedBlocks: 0,
    peakBlocks: 0,
    lastFocusedViewReadyMs: null,
    avgFocusedViewReadyMs: 0,
    focusedViewLoadCount: 0,
  };
  
  constructor() {
    // Check for performance API availability
    if (typeof performance === 'undefined') {
      this.enabled = false;
    }
  }
  
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }
  
  isEnabled() {
    return this.enabled;
  }

  // ==================== Gauge Tracking (Phase 6) ====================
  
  /**
   * Track NodeView mount/unmount for max NodeView count metric
   */
  nodeViewMounted() {
    this.gauges.mountedNodeViews++;
    if (this.gauges.mountedNodeViews > this.gauges.peakNodeViews) {
      this.gauges.peakNodeViews = this.gauges.mountedNodeViews;
    }
  }
  
  nodeViewUnmounted() {
    this.gauges.mountedNodeViews = Math.max(0, this.gauges.mountedNodeViews - 1);
  }
  
  /**
   * Track Block mount/unmount for nodes mounted metric
   */
  blockMounted() {
    this.gauges.mountedBlocks++;
    if (this.gauges.mountedBlocks > this.gauges.peakBlocks) {
      this.gauges.peakBlocks = this.gauges.mountedBlocks;
    }
  }
  
  blockUnmounted() {
    this.gauges.mountedBlocks = Math.max(0, this.gauges.mountedBlocks - 1);
  }
  
  /**
   * Track focused view ready time
   */
  focusedViewReady(durationMs: number) {
    this.gauges.lastFocusedViewReadyMs = durationMs;
    this.gauges.focusedViewLoadCount++;
    // Calculate rolling average
    const prevTotal = this.gauges.avgFocusedViewReadyMs * (this.gauges.focusedViewLoadCount - 1);
    this.gauges.avgFocusedViewReadyMs = (prevTotal + durationMs) / this.gauges.focusedViewLoadCount;
  }
  
  /**
   * Get current gauge values
   */
  getGauges(): PerformanceGauges {
    return { ...this.gauges };
  }

  // ==================== General Marks ====================
  
  markStart(name: string, metadata?: Record<string, unknown>) {
    if (!this.enabled) return;
    
    this.metrics.set(name, {
      name,
      startTime: performance.now(),
      metadata,
    });
    
    // Also use native Performance API for DevTools
    performance.mark(`notees:${name}:start`);
  }
  
  markEnd(name: string, metadata?: Record<string, unknown>) {
    if (!this.enabled) return;
    
    const metric = this.metrics.get(name);
    if (!metric) return;
    
    const endTime = performance.now();
    metric.endTime = endTime;
    metric.duration = endTime - metric.startTime;
    
    if (metadata) {
      metric.metadata = { ...metric.metadata, ...metadata };
    }
    
    // Native Performance API
    performance.mark(`notees:${name}:end`);
    try {
      performance.measure(
        `notees:${name}`,
        `notees:${name}:start`,
        `notees:${name}:end`
      );
    } catch {
      // Marks may have been cleared
    }
    
    return metric.duration;
  }
  
  measure(name: string): number | undefined {
    return this.metrics.get(name)?.duration;
  }

  // ==================== Render Tracking ====================
  
  trackRender(componentName: string, duration: number) {
    if (!this.enabled) return;
    
    const existing = this.renderMetrics.get(componentName);
    if (existing) {
      existing.renderCount++;
      existing.totalDuration += duration;
      existing.avgDuration = existing.totalDuration / existing.renderCount;
      existing.lastRenderTime = performance.now();
    } else {
      this.renderMetrics.set(componentName, {
        componentName,
        renderCount: 1,
        totalDuration: duration,
        avgDuration: duration,
        lastRenderTime: performance.now(),
      });
    }
  }
  
  getRenderMetrics(): RenderMetric[] {
    return Array.from(this.renderMetrics.values());
  }

  // ==================== Node Load Tracking ====================
  
  nodeLoadStart(nodeId: number) {
    if (!this.enabled) return;
    
    this.nodeLoadMetrics.set(nodeId, {
      nodeId,
      loadStartTime: performance.now(),
    });
  }
  
  nodeContentReady(nodeId: number) {
    if (!this.enabled) return;
    
    const metric = this.nodeLoadMetrics.get(nodeId);
    if (metric) {
      metric.contentReadyTime = performance.now();
    }
  }
  
  nodeChildrenReady(nodeId: number) {
    if (!this.enabled) return;
    
    const metric = this.nodeLoadMetrics.get(nodeId);
    if (metric) {
      metric.childrenReadyTime = performance.now();
      metric.totalDuration = metric.childrenReadyTime - metric.loadStartTime;
    }
  }
  
  getNodeLoadMetric(nodeId: number): NodeLoadMetric | undefined {
    return this.nodeLoadMetrics.get(nodeId);
  }

  // ==================== Reporting ====================
  
  getReport(): {
    marks: PerformanceMetric[];
    renders: RenderMetric[];
    nodeLoads: NodeLoadMetric[];
    gauges: PerformanceGauges;
  } {
    return {
      marks: Array.from(this.metrics.values()),
      renders: this.getRenderMetrics(),
      nodeLoads: Array.from(this.nodeLoadMetrics.values()),
      gauges: this.getGauges(),
    };
  }
  
  clear() {
    this.metrics.clear();
    this.renderMetrics.clear();
    this.nodeLoadMetrics.clear();
    // Reset gauges but keep peaks for session analysis
    this.gauges.mountedNodeViews = 0;
    this.gauges.mountedBlocks = 0;
    
    // Clear native marks
    try {
      performance.clearMarks();
      performance.clearMeasures();
    } catch {
      // May not be supported
    }
  }
  
  log() {
    if (!this.enabled) return;
    
    console.group('🔬 Notees Performance Report');
    
    const report = this.getReport();
    
    // Phase 6: Gauges first for quick visibility
    console.group('📊 Current Gauges');
    console.log(`NodeViews mounted: ${report.gauges.mountedNodeViews} (peak: ${report.gauges.peakNodeViews})`);
    console.log(`Blocks mounted: ${report.gauges.mountedBlocks} (peak: ${report.gauges.peakBlocks})`);
    if (report.gauges.lastFocusedViewReadyMs !== null) {
      console.log(`Last focused view ready: ${report.gauges.lastFocusedViewReadyMs.toFixed(2)}ms`);
      console.log(`Avg focused view ready: ${report.gauges.avgFocusedViewReadyMs.toFixed(2)}ms (n=${report.gauges.focusedViewLoadCount})`);
    }
    console.groupEnd();
    
    console.group('⏱️ Timing Marks');
    report.marks
      .filter(m => m.duration !== undefined)
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .forEach(m => {
        console.log(`${m.name}: ${m.duration?.toFixed(2)}ms`, m.metadata || '');
      });
    console.groupEnd();
    
    console.group('🔄 Render Metrics');
    report.renders
      .sort((a, b) => b.renderCount - a.renderCount)
      .slice(0, 20)
      .forEach(r => {
        console.log(
          `${r.componentName}: ${r.renderCount} renders, avg ${r.avgDuration.toFixed(2)}ms`
        );
      });
    console.groupEnd();
    
    console.group('📦 Node Load Times');
    report.nodeLoads
      .filter(n => n.totalDuration !== undefined)
      .sort((a, b) => (b.totalDuration ?? 0) - (a.totalDuration ?? 0))
      .slice(0, 10)
      .forEach(n => {
        console.log(`Node ${n.nodeId}: ${n.totalDuration?.toFixed(2)}ms total`);
      });
    console.groupEnd();
    
    console.groupEnd();
  }
}

// Singleton instance
export const perfStore = new PerformanceStore();

// ==================== React Hooks ====================

import { useEffect, useRef, useCallback } from 'react';

/**
 * Hook for performance marks in components
 */
export function usePerformanceMarks(componentName: string) {
  const markStart = useCallback((name: string, metadata?: Record<string, unknown>) => {
    perfStore.markStart(`${componentName}:${name}`, metadata);
  }, [componentName]);
  
  const markEnd = useCallback((name: string, metadata?: Record<string, unknown>) => {
    return perfStore.markEnd(`${componentName}:${name}`, metadata);
  }, [componentName]);
  
  const measure = useCallback((name: string) => {
    return perfStore.measure(`${componentName}:${name}`);
  }, [componentName]);
  
  return { markStart, markEnd, measure };
}

/**
 * Hook to track component renders
 */
export function useRenderTracking(componentName: string) {
  const renderStartRef = useRef<number>(0);
  
  // Track render start
  // eslint-disable-next-line react-hooks/rules-of-hooks
  renderStartRef.current = performance.now();
  
  useEffect(() => {
    // Track render end (after commit)
    const duration = performance.now() - renderStartRef.current;
    perfStore.trackRender(componentName, duration);
  });
}

/**
 * Hook to track node loading performance
 */
export function useNodeLoadTracking(nodeId: number | null, isLoading: boolean) {
  const trackedRef = useRef(false);
  
  useEffect(() => {
    if (!nodeId) return;
    
    if (isLoading && !trackedRef.current) {
      trackedRef.current = true;
      perfStore.nodeLoadStart(nodeId);
    } else if (!isLoading && trackedRef.current) {
      perfStore.nodeContentReady(nodeId);
    }
  }, [nodeId, isLoading]);
  
  const markChildrenReady = useCallback(() => {
    if (nodeId) {
      perfStore.nodeChildrenReady(nodeId);
    }
  }, [nodeId]);
  
  return { markChildrenReady };
}

/**
 * Hook to measure time to first render
 */
export function useTimeToFirstRender(name: string) {
  const mounted = useRef<boolean | null>(null);
  
  useEffect(() => {
    if (mounted.current == null) {
      mounted.current = true;
      perfStore.markEnd(`${name}:firstRender`);
    }
  }, [name]);
  
  // Mark start on first call
  if (mounted.current == null) {
    perfStore.markStart(`${name}:firstRender`);
  }
}

/**
 * Hook to track NodeView mount/unmount (Phase 6)
 * Add this to NodeView components to track max mounted count
 */
export function useNodeViewTracking() {
  useEffect(() => {
    perfStore.nodeViewMounted();
    return () => perfStore.nodeViewUnmounted();
  }, []);
}

/**
 * Hook to track Block mount/unmount (Phase 6)
 * Add this to Block components to track total rendered nodes
 */
export function useBlockTracking() {
  useEffect(() => {
    perfStore.blockMounted();
    return () => perfStore.blockUnmounted();
  }, []);
}

/**
 * Hook to track focused view ready time (Phase 6)
 * Use in useFocusedView or NodeView to measure navigation performance
 */
export function useFocusedViewTracking(nodeId: number | null, isReady: boolean) {
  const startTimeRef = useRef<number | null>(null);
  const trackedRef = useRef<number | null>(null);
  
  useEffect(() => {
    // New navigation - start tracking
    if (nodeId && nodeId !== trackedRef.current && !isReady) {
      startTimeRef.current = performance.now();
      trackedRef.current = null;
    }
    
    // Navigation complete - record duration
    if (nodeId && isReady && startTimeRef.current && trackedRef.current !== nodeId) {
      const duration = performance.now() - startTimeRef.current;
      perfStore.focusedViewReady(duration);
      trackedRef.current = nodeId;
      startTimeRef.current = null;
    }
  }, [nodeId, isReady]);
}

// ==================== Development Helpers ====================

// Expose to window for manual inspection in dev
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __NOTEES_PERF__: PerformanceStore }).__NOTEES_PERF__ = perfStore;
}

export default perfStore;
