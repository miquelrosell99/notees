/**
 * UI primitives kit — shared presentational components.
 *
 * Ported from the archived frontend with class names and CSS kept verbatim
 * against the token system in `../../variables.css`.
 */

export { Button } from './Button.js';
export type { ButtonProps, ButtonVariant, ButtonSize, ButtonHapticIntensity, ButtonBadge } from './Button.js';

export { Dropdown } from './Dropdown.js';
export type { DropdownProps, DropdownOption, DropdownSize } from './Dropdown.js';

export { Modal } from './Modal.js';
export type { ModalProps, ModalSize, ModalVariant } from './Modal.js';

export { ConfirmationModal } from './ConfirmationModal.js';

export { ContextMenu } from './ContextMenu.js';
export type { ContextMenuItem, ContextMenuAnchor, ContextMenuProps } from './ContextMenu.js';

export { Badge } from './Badge.js';
export type { BadgeProps, BadgeVariant, BadgeSize } from './Badge.js';

export { EmptyState } from './EmptyState.js';
export type { EmptyStateProps } from './EmptyState.js';

export { NotificationToast } from './NotificationToast.js';
export type { ToastNotification } from './NotificationToast.js';
