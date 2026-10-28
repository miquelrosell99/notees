/**
 * SelectTrigger - Common trigger component for select/dropdown inputs
 *
 * Provides consistent styling and behavior for:
 * - Dropdown component
 * - NodePicker component
 * - Any other select-like components
 *
 * Features:
 * - Card-based appearance with border
 * - Chevron icon that rotates when open
 * - Optional clear button (outside to the right)
 * - Keyboard navigation support
 *
 * Self-contained fleet trigger: the catalog-button radix/cva composition
 * (the normalized shadcn button — theme-key utilities only, fleet radii,
 * the state-layer hover, the focus ring from --ring) now lives here as the
 * private TriggerButton; the boxed field register is applied to it through
 * the class merge. The sm/md/lg row heights, the open/error states, the
 * chevron, and the clear affordance are the app's and live here. The fleet
 * field register overrides the button's default variant (no press scale,
 * the 12px input corner, no hover wash) through the class merge.
 *
 * INTERACTION CONTRACT (bridge checklist #9 — documented override): the
 * pre-catalog primitive fired onClick on Enter/Space KEYDOWN via a
 * keydown shim; the catalog button uses the native button contract
 * (Enter fires click, Space fires on keyup) — the shim is dropped, the
 * aria-haspopup/aria-expanded surface is unchanged.
 *
 * Legacy hook classes: `select-trigger` (+ size/open/error/disabled
 * variants), `select-trigger__content/value/chevron`, and
 * `select-trigger-container` stay — feature CSS and tests compound on
 * them.
 */
import { type ReactNode, type MouseEvent, type ButtonHTMLAttributes, forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { Button } from './Button.js';
import { Icon } from '../../../ui/Icon.js';
import { cn } from './cn.js';

export type SelectTriggerSize = 'sm' | 'md' | 'lg';

export interface SelectTriggerProps {
  /** Whether the dropdown is open */
  isOpen: boolean;
  /** Whether the trigger is disabled */
  disabled?: boolean | undefined;
  /** Whether to show error state */
  error?: boolean | undefined;
  /** Size variant */
  size?: SelectTriggerSize | undefined;
  /** Content to display in the trigger */
  children: ReactNode;
  /** Whether to show the clear button */
  clearable?: boolean | undefined;
  /** Whether there is content to clear (controls clear button visibility) */
  hasValue?: boolean | undefined;
  /** Click handler for the trigger */
  onClick: () => void;
  /** Click handler for the clear button */
  onClear?: ((e: MouseEvent) => void) | undefined;
  /** Additional CSS class */
  className?: string | undefined;
  /** Tab index */
  tabIndex?: number | undefined;
  /** ARIA label */
  ariaLabel?: string | undefined;
  /** Whether the field has an error (for aria-invalid) */
  'aria-invalid'?: boolean | undefined;
  /** ID of element describing this field (for aria-describedby) */
  'aria-describedby'?: string | undefined;
}

const CONTENT_CLASSES: Record<SelectTriggerSize, string> = {
  sm: 'min-h-md px-3',
  md: 'min-h-lg px-4',
  lg: 'min-h-xl px-5',
};

/**
 * The catalog-button composition (absorbed from the retired
 * src/components/ui/button.tsx layer): the normalized shadcn button on
 * Radix Slot — theme-key utilities only, fleet radii, the state-layer
 * hover via the --accent alias, the focus ring from --ring. Private to
 * this file; SelectTrigger composes it as a plain button (variant ghost).
 */
const triggerButtonVariants = cva(
  'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-button border font-sans font-medium select-none transition-colors duration-short ease-standard active:scale-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground border-primary hover:bg-primary-hover',
        secondary:
          'bg-secondary text-secondary-foreground border-secondary hover:bg-surface-container-high',
        outline:
          'bg-transparent border-input text-on-surface-variant hover:bg-accent hover:text-accent-foreground hover:border-outline',
        ghost:
          'bg-transparent border-transparent text-on-surface-variant hover:bg-accent hover:text-accent-foreground',
        destructive:
          'bg-destructive text-destructive-foreground border-destructive hover:bg-error-hover',
        link: 'border-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-button-md px-3 text-button',
        sm: 'h-button-sm px-2 text-sm rounded-button-sm',
        lg: 'h-button-lg px-4 text-base',
        icon: 'h-button-md w-button-md',
        'icon-sm': 'h-button-sm w-button-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

interface TriggerButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof triggerButtonVariants> {
  asChild?: boolean;
}

const TriggerButton = forwardRef<HTMLButtonElement, TriggerButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(triggerButtonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
TriggerButton.displayName = 'TriggerButton';

/**
 * SelectTrigger Component
 */
export function SelectTrigger({
  isOpen,
  disabled = false,
  error = false,
  size = 'md',
  children,
  clearable = false,
  hasValue = false,
  onClick,
  onClear,
  className = '',
  tabIndex = 0,
  ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedby,
}: SelectTriggerProps) {
  const handleClearClick = (e: MouseEvent) => {
    e.stopPropagation();
    onClear?.(e);
  };

  return (
    <div
      className={cn(
        'select-trigger-container flex w-full items-center gap-1',
        clearable && hasValue && onClear && 'select-trigger-container--with-clear',
      )}
    >
      <TriggerButton
        type="button"
        variant="ghost"
        disabled={disabled}
        tabIndex={disabled ? -1 : tabIndex}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        data-invalid={ariaInvalid || undefined}
        onClick={disabled ? undefined : onClick}
        className={cn(
          'select-trigger h-auto w-full cursor-pointer rounded-input border-outline-variant bg-surface font-normal text-on-surface',
          'active:scale-100 hover:bg-surface',
          'transition-[border-color,box-shadow] duration-short ease-standard',
          CONTENT_CLASSES[size],
          `select-trigger--${size}`,
          isOpen && 'select-trigger--open border-primary',
          error && 'select-trigger--error border-error',
          disabled && 'select-trigger--disabled cursor-not-allowed opacity-50',
          className,
        )}
      >
        <span className="select-trigger__content flex w-full items-center justify-between gap-1">
          {/* Main content area */}
          <span className="select-trigger__value flex min-w-0 flex-1 items-center gap-1">
            {children}
          </span>

          {/* Chevron icon */}
          <span className="select-trigger__chevron flex shrink-0 items-center text-on-surface-variant">
            <Icon
              path={"mdi mdi-chevron-down"}
              size={0.7}
              className={cn('transition-transform duration-short ease-standard', isOpen && 'select-trigger__chevron-icon--open rotate-180')}
            />
          </span>
        </span>
      </TriggerButton>

      {/* Clear button - outside the trigger */}
      {clearable && hasValue && onClear && (
        <Button
          icon={"mdi mdi-close"}
          variant="ghost"
          size="sm"
          onClick={handleClearClick}
          aria-label="Clear selection"
          className="select-trigger__clear-btn shrink-0"
        />
      )}
    </div>
  );
}
