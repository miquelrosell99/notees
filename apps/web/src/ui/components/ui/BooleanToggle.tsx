/**
 * BooleanToggle Component
 *
 * A toggle switch component for boolean values.
 *
 * Thin fleet wrapper over the Radix switch (the same foundation the
 * migrated ToggleSwitch rides): the Radix Switch root IS the interactive
 * control (role=switch, aria-checked, keyboard), the track/thumb geometry,
 * the ON/OFF in-track text, the optional label + description, and the
 * light haptic are the app's register and live here. The calc'd thumb
 * shift has no utility form (the drift gate bans arbitrary values), so it
 * rides inline styles referencing the tokens — values stay token-owned.
 *
 * INTERACTION CONTRACT (bridge checklist #9 — documented override): the
 * pre-catalog primitive was a NATIVE <input type=checkbox role=switch>;
 * the catalog root is a Radix <button role=switch>. The public surface
 * preserves checked/disabled/label association; the documented delta is
 * that onChange now receives the boolean state (the change-event shape
 * retired with the native input) and the ref targets the focusable root.
 *
 * Legacy hook classes: `toggle-container` (+ size/label/disabled
 * variants), `toggle-track--${size}`, `toggle-thumb`, and the label
 * hooks stay — feature CSS compounds on them.
 */

import { forwardRef, useId, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';

import { useReducedMotion } from './overlay-hooks.js';
import { cn } from './cn';

export type BooleanToggleSize = 'sm' | 'md' | 'lg';

export interface BooleanToggleProps
  extends Omit<HTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  /** Toggle size */
  size?: BooleanToggleSize;
  /** Label content */
  label?: ReactNode;
  /** Description text below label */
  description?: ReactNode;
  /** Label position */
  labelPosition?: 'left' | 'right';
  /** Whether to show on/off text inside the toggle */
  showOnOff?: boolean;
  /** Whether the switch is on */
  checked?: boolean;
  /** Default (uncontrolled) state */
  defaultChecked?: boolean;
  /** Callback when the state changes — receives the new boolean. */
  onChange?: ((checked: boolean) => void) | undefined;
  /** Whether the switch is disabled */
  disabled?: boolean;
}

/** Track geometry per size — the register the old CSS owned. */
const TRACK_STYLE: Record<BooleanToggleSize, CSSProperties> = {
  sm: { width: 'var(--icon-size-xl)', height: 'var(--icon-size-md)' },
  md: { width: 'var(--toggle-track-width-md)', height: 'var(--height-xs)' },
  lg: { width: 'var(--toggle-track-width-lg)', height: 'var(--toggle-track-height-lg)' },
};

const THUMB_TOKEN: Record<BooleanToggleSize, string> = {
  sm: 'var(--shape-extra-large)',
  md: 'var(--spacing-4)',
  lg: 'var(--bullet-wrapper-size)',
};

const THUMB_PAD = 'var(--shape-small)';

const LABEL_SIZE: Record<BooleanToggleSize, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-md',
};

/**
 * BooleanToggle (Switch) component with optional label and description.
 */
export const BooleanToggle = forwardRef<HTMLButtonElement, BooleanToggleProps>(
  function BooleanToggle(
    {
      size = 'md',
      label,
      description,
      labelPosition = 'right',
      showOnOff = false,
      checked,
      defaultChecked,
      onChange,
      className = '',
      disabled = false,
      id,
      ...rest
    },
    ref,
  ) {
    const generatedId = useId();
    const toggleId = id || generatedId;
    const prefersReducedMotion = useReducedMotion();

    const handleChange = (next: boolean) => {
      // Tactile feedback on mobile — switches use the light (10ms) haptic.
      // Skip haptics when the user prefers reduced motion.
      if (!prefersReducedMotion && typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(10);
      }
      onChange?.(next);
    };

    const thumb = THUMB_TOKEN[size];
    const thumbShift = `translateY(-50%) translateX(calc(${TRACK_STYLE[size]!.width} - ${thumb} - 2 * ${THUMB_PAD}))`;

    const labelElement = (label || description) && (
      <div className={cn('toggle-label-wrapper flex min-w-0 flex-col gap-1', labelPosition === 'left' && 'flex-1')}>
        {label && (
          <label htmlFor={toggleId} className={cn('toggle-label select-none text-on-surface', LABEL_SIZE[size])}>
            {label}
          </label>
        )}
        {description && <span className="toggle-description text-sm text-on-surface-variant">{description}</span>}
      </div>
    );

    return (
      <div
        className={cn(
          'toggle-container flex items-start gap-2',
          `toggle-container--${size}`,
          `toggle-container--label-${labelPosition}`,
          labelPosition === 'left' && 'justify-between',
          disabled && 'toggle-container--disabled cursor-not-allowed opacity-50',
          className,
        )}
      >
        {labelPosition === 'left' && labelElement}
        <SwitchPrimitive.Root
          ref={ref}
          id={toggleId}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={handleChange}
          disabled={disabled}
          className={cn(
            'toggle-input-wrapper relative flex shrink-0 items-center border-0 bg-transparent p-0',
            disabled ? 'pointer-events-none cursor-not-allowed' : 'cursor-pointer',
            'focus-visible:outline-none focus-visible:outline-offset-micro focus-visible:ring-2 focus-visible:ring-ring',
          )}
          {...rest}
        >
          <span
            aria-hidden="true"
            className={cn(
              'toggle-track relative flex items-center rounded-full transition-[background-color,box-shadow] duration-short ease-standard',
              `toggle-track--${size}`,
              checked
                ? 'toggle-track--on bg-primary shadow-none'
                : 'bg-surface-variant shadow-inset-outline-ring hover:shadow-inset-primary-ring',
            )}
            style={TRACK_STYLE[size]}
          >
            {showOnOff && size !== 'sm' && (
              <>
                <span
                  className={cn(
                    'toggle-on-text absolute left-1 text-xs font-semibold uppercase text-on-primary transition-opacity duration-short ease-standard',
                    checked ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  ON
                </span>
                <span
                  className={cn(
                    'toggle-off-text absolute right-1 text-xs font-semibold uppercase text-outline transition-opacity duration-short ease-standard',
                    checked ? 'opacity-0' : 'opacity-100',
                  )}
                >
                  OFF
                </span>
              </>
            )}
            <SwitchPrimitive.Thumb
              className="toggle-thumb absolute top-1/2 block rounded-full transition-[transform,background-color] duration-short ease-standard"
              style={{
                left: THUMB_PAD,
                width: thumb,
                height: thumb,
                transform: checked ? thumbShift : 'translateY(-50%)',
                background: checked
                  ? 'var(--md-sys-color-on-primary)'
                  : 'var(--md-sys-color-outline)',
              }}
            />
          </span>
          {/* Invisible minimum hit-area overlay (M3's 48dp floor) — the
              same contract the old absolute input carried, as a real
              element so it needs no stylesheet. */}
          {!disabled && (
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 min-h-touch min-w-touch -translate-x-1/2 -translate-y-1/2"
            />
          )}
        </SwitchPrimitive.Root>
        {labelPosition === 'right' && labelElement}
      </div>
    );
  },
);
