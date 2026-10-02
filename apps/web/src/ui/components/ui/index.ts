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

export { NotificationToaster } from './NotificationToaster.js';

export { notificationStore, useNotificationList, useNotifications } from './notificationStore.js';
export type { Notification, NotificationType } from './notificationStore.js';

export { BackendUnavailableOverlay } from './BackendUnavailableOverlay.js';
export type { BackendUnavailableOverlayProps } from './BackendUnavailableOverlay.js';

export { Card } from './Card.js';
export type { CardProps, CardElevation, CardVariant, CardRadius } from './Card.js';

export { SelectTrigger } from './SelectTrigger.js';
export type { SelectTriggerProps, SelectTriggerSize } from './SelectTrigger.js';

export { Separator } from './Separator.js';
export type { SeparatorProps, SeparatorOrientation, SeparatorSize } from './Separator.js';

export { Spinner } from './Spinner.js';
export type { SpinnerProps } from './Spinner.js';

export { LoadingSkeleton, Skeleton } from './LoadingSkeleton.js';
export type { LoadingSkeletonProps, SkeletonProps, SkeletonShape, SkeletonWidth } from './LoadingSkeleton.js';

export { TextField } from './TextField.js';
export type { TextFieldProps, TextFieldSize } from './TextField.js';

export { ToggleSwitch } from './ToggleSwitch.js';
export type { ToggleSwitchProps, ToggleSwitchSize } from './ToggleSwitch.js';

export { SelectionButton } from './SelectionButton.js';
export type {
  SelectionButtonProps,
  SelectionButtonOption,
  SelectionButtonSize,
  SelectionButtonOrientation,
} from './SelectionButton.js';

export { BooleanToggle } from './BooleanToggle.js';
export type { BooleanToggleProps, BooleanToggleSize } from './BooleanToggle.js';

export { ButtonWithPanel } from './ButtonWithPanel.js';
export type { ButtonWithPanelProps, PanelPosition, PanelAlignment } from './ButtonWithPanel.js';

export { Checkbox } from './Checkbox.js';
export type { CheckboxProps, CheckboxSize } from './Checkbox.js';

export { Pill } from './Pill.js';
export type { PillProps } from './Pill.js';

export { AddPill } from './AddPill.js';
export type { AddPillProps } from './AddPill.js';

export { Slider } from './Slider.js';
export type { SliderProps, SliderSize } from './Slider.js';

export { Tabs } from './Tabs.js';
export type { TabsProps, TabsListProps, TabsVariant, TabProps, TabsAddButtonProps, TabPanelProps } from './Tabs.js';

export { ColorButton } from './ColorButton.js';
export type { ColorButtonProps, ColorButtonSize, ColorEntry } from './ColorButton.js';

export { PRESET_COLOR_ENTRIES } from './colorPresets.js';
export type { ColorEntry as PresetColorEntry } from './colorPresets.js';

export { ErrorBoundary } from './ErrorBoundary.js';

export { FileDropZone } from './FileDropZone.js';

export { ImageModal } from './ImageModal.js';
export type { ImageModalProps } from './ImageModal.js';

export { InlineConfirmButton } from './InlineConfirmButton.js';

export { ListSortable } from './ListSortable.js';
export type { ListSortableProps, ListSortableItem, DragState } from './ListSortable.js';

export { useListDragSort } from './useListDragSort.js';
export type { UseListDragSortParams, UseListDragSortResult } from './useListDragSort.js';

export { LoadingScreen } from './LoadingScreen.js';
export type { LoadingScreenProps } from './LoadingScreen.js';

export { DataStateView } from './DataStateView.js';
export type { DataStateViewProps } from './DataStateView.js';

export { CodeTextarea } from './CodeTextarea.js';

export { SearchField } from './SearchField.js';
export type { SearchFieldProps } from './SearchField.js';

export { FloatingButtonArray, ToolbarDivider } from './FloatingButtonArray.js';
export type { FloatingButtonArrayProps, ToolbarDividerProps } from './FloatingButtonArray.js';

export { MonthCalendar } from './calendar/MonthCalendar.js';
export type { MonthCalendarProps } from './calendar/MonthCalendar.js';
