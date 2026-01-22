/**
 * NodePlaceholder Component
 * 
 * Lightweight placeholder for virtualized nodes.
 * Shows a minimal representation while the full node is off-screen.
 * 
 * Used with useVirtualizedNodes hook for viewport-based rendering.
 */
import type { NodePlaceholderProps } from '@/hooks/useVirtualizedNodes';
import './NodePlaceholder.css';

export function NodePlaceholder({ 
  height = 32, 
  shimmer = false,
  className = '' 
}: NodePlaceholderProps) {
  return (
    <div 
      className={`node-placeholder ${shimmer ? 'node-placeholder--shimmer' : ''} ${className}`}
      style={{ height }}
      aria-hidden="true"
    />
  );
}

export default NodePlaceholder;
