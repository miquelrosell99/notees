/**
 * LinkBadge Component
 * 
 * Shared visual component for displaying node links (pages and blocks).
 * Used by both NodeLink (edit mode) and InlineLink (non-edit mode).
 * 
 * Features:
 * - Card-style with small rounded corners and faded background
 * - Optional icon, text, and click count badge
 * - Separate styling for page vs block links
 */
import React from 'react';
import { Card } from './Card';
import { NodeIcon } from '../icons';
import './LinkBadge.css';

export interface LinkBadgeProps {
  /** Display text for the link */
  text: string;
  /** Whether this is a page (affects styling and icon rendering) */
  isPage?: boolean;
  /** Optional icon to display */
  icon?: string;
  /** Click count badge */
  clickCount?: number;
  /** Additional CSS class */
  className?: string;
  /** Whether interactive (clickable) */
  interactive?: boolean;
}

export const LinkBadge: React.FC<LinkBadgeProps> = ({
  text,
  isPage = true,
  icon,
  clickCount = 0,
  className = '',
  interactive = true,
}) => {
  return (
    <Card
      className={`link-badge ${isPage ? 'link-badge--page' : 'link-badge--block'} ${className}`}
      elevation="none"
      variant="filled"
      padding={false}
      radius="sm"
      interactive={interactive}
    >
      {icon && (
        <span className="link-badge__icon">
          <NodeIcon icon={icon} isPage={isPage} size="xs" />
        </span>
      )}
      <span className="link-badge__text">{text}</span>
      {clickCount > 0 && (
        <span className="link-badge__badge">{clickCount}</span>
      )}
    </Card>
  );
};
