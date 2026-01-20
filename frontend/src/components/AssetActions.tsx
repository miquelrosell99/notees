/**
 * AssetActions Component
 * 
 * Reusable action buttons for asset components (banner, cover, etc.)
 * Displays edit and remove buttons in a floating card overlay.
 */
import { type ReactNode } from 'react';
import { Button } from './core/Button';
import { Card } from './core/Card';
import { mdiPencil, mdiClose } from '@mdi/js';
import './AssetActions.css';

interface AssetActionsProps {
  /** Callback when edit/change button is clicked */
  onEdit?: () => void;
  /** Callback when remove button is clicked */
  onRemove?: () => void;
  /** Whether the actions are visible */
  visible?: boolean;
  /** Custom class name */
  className?: string;
  /** Position variant */
  position?: 'bottom-right' | 'bottom-center' | 'top-right' | 'left';
  /** Additional buttons to render before the default ones */
  children?: ReactNode;
  /** Compact mode with reduced padding and spacing */
  compact?: boolean;
}

export function AssetActions({
  onEdit,
  onRemove,
  visible = true,
  className = '',
  position = 'bottom-right',
  children,
  compact = false,
}: AssetActionsProps) {
  if (!visible) return null;
  
  return (
    <Card 
      className={`asset-actions asset-actions--${position} ${compact ? 'asset-actions--compact' : ''} ${className}`}
      elevation="medium"
      variant="filled"
      padding={false}
      radius="sm"
    >
      <div className="asset-actions__inner">
        {children}
      {onEdit && (
        <Button
          icon={mdiPencil}
          variant="ghost"
          size="sm"
          onClick={onEdit}
          title="Change image"
        />
      )}
      {onRemove && (
        <Button
          icon={mdiClose}
          variant="ghost"
          size="sm"
          onClick={onRemove}
          title="Remove image"
        />
      )}
      </div>
    </Card>
  );
}

export default AssetActions;
