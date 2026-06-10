/**
 * QueryBlockCard Component
 * 
 * Unified card element for query blocks (both conditions and groups).
 * Provides consistent layout: content area + optional corner button + optional action button.
 * 
 * Used by:
 * - ProseConditionBuilder (conditions)
 * - QueryBlockBuilder (AND/OR/NOT groups)
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/Button';
import './QueryBlockCard.css';
import { Icon } from '@/components/ui/icons';

// ==================== Types ====================

interface QueryBlockCardProps {
  /** Main content of the card */
  children: ReactNode;
  /** Whether this is a system/locked block */
  isSystem?: boolean;
  /** Whether the block can be removed */
  canRemove?: boolean;
  /** Whether the block is read-only */
  readOnly?: boolean;
  /** Callback when remove button is clicked */
  onRemove?: () => void;
  /** Label to show in the corner button tooltip when system */
  systemTooltip?: string;
  /** Optional action button (e.g., SelectionButton for groups) */
  actionButton?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

// ==================== Main Component ====================

export function QueryBlockCard({
  children,
  isSystem = false,
  canRemove = true,
  readOnly = false,
  onRemove,
  systemTooltip = 'This filter is required for this view type',
  actionButton,
  className = '',
}: QueryBlockCardProps) {
  return (
    <div className={`query-block-card ${isSystem ? 'query-block-card--system' : ''} ${className}`}>
      {/* Main content */}
      <div className="query-block-card__content">
        {children}
      </div>
      
      {/* Optional action button (e.g., SelectionButton for logic changes) */}
      {actionButton && (
        <div className="query-block-card__action">
          {actionButton}
        </div>
      )}
      
      {/* Corner button - lock for system, delete for removable */}
      {isSystem ? (
        <div 
          className="query-block-card__corner-button query-block-card__corner-button--system hover-reveal" 
          title={systemTooltip}
        >
          <Icon path={"mdi mdi-lock"} size={0.55} />
        </div>
      ) : canRemove && !readOnly && onRemove ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={onRemove}
          title="Remove"
          className="query-block-card__corner-button hover-reveal"
          icon={"mdi mdi-close"}
        />
      ) : null}
    </div>
  );
}

