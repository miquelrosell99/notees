/**
 * SidebarCard Component
 * 
 * A reusable container for displaying content in the right sidebar.
 * Used for pages, blocks, local graphs, and other sidebar content.
 * 
 * Built on top of the core Card component for consistent styling.
 */
import { useState, type ReactNode } from 'react';
import { mdiClose, mdiChevronDown } from '@mdi/js';
import Icon from '@mdi/react';
import './SidebarCard.css';
import { AlertIcon } from '../core/icons';
import { Button } from '../core/Button';
import { Card } from '../core/Card';

interface SidebarCardProps {
  /** Card title */
  title?: ReactNode;
  /** Icon to display before the title */
  icon?: ReactNode;
  /** Optional subtitle or info text */
  subtitle?: string;
  /** Card content */
  children: ReactNode;
  /** Close handler */
  onClose?: () => void;
  /** Additional CSS class */
  className?: string;
  /** Whether to show the header */
  showHeader?: boolean;
  /** Whether to make content scrollable */
  scrollable?: boolean;
  /** Loading state */
  loading?: boolean;
  /** Error state */
  error?: string;
  /** Retry handler for error state */
  onRetry?: () => void;
  /** Whether the card starts collapsed */
  defaultCollapsed?: boolean;
}

export function SidebarCard({
  title,
  icon,
  subtitle,
  children,
  onClose,
  className = '',
  showHeader = true,
  scrollable = true,
  loading = false,
  error,
  onRetry,
  defaultCollapsed = false,
}: SidebarCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  if (loading) {
    return (
      <Card 
        className={`sidebar-card sidebar-card--loading ${className}`}
        elevation="low"
        variant="default"
        padding={false}
        radius="md"
      >
        <div className="sidebar-card__loader">
          <div className="sidebar-card__spinner" />
          <span>Loading...</span>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card 
        className={`sidebar-card sidebar-card--error ${className}`}
        elevation="low"
        variant="default"
        padding={false}
        radius="md"
      >
        <div className="sidebar-card__error">
          <span className="sidebar-card__error-icon"><AlertIcon size="sm" /></span>
          <p className="sidebar-card__error-message">{error}</p>
          {onRetry && (
            <Button variant="default" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card 
      className={`sidebar-card ${isCollapsed ? 'sidebar-card--collapsed' : ''} ${className}`}
      elevation="low"
      variant="default"
      padding={false}
      radius="md"
    >
      {showHeader && (title || onClose) && (
        <div className="sidebar-card__header">
          <button
            className="sidebar-card__collapse-btn"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? "Expand" : "Collapse"}
            aria-label={isCollapsed ? "Expand card" : "Collapse card"}
            aria-expanded={!isCollapsed}
          >
            <Icon path={mdiChevronDown} size={0.6} rotate={isCollapsed ? -90 : 0} />
          </button>
          <div className="sidebar-card__title-section">
            {icon && <span className="sidebar-card__icon">{icon}</span>}
            <div className="sidebar-card__titles">
              {title && <h3 className="sidebar-card__title">{title}</h3>}
              {subtitle && <p className="sidebar-card__subtitle">{subtitle}</p>}
            </div>
          </div>
          {onClose && (
            <Button
              icon={mdiClose}
              iconOnly
              className="sidebar-card__close-btn"
              onClick={onClose}
              title="Close"
              size="sm"
              variant="ghost"
            />
          )}
        </div>
      )}
      {!isCollapsed && (
        <div className={`sidebar-card__content ${scrollable ? 'sidebar-card__content--scrollable' : ''}`}>
          {children}
        </div>
      )}
    </Card>
  );
}

export default SidebarCard;
