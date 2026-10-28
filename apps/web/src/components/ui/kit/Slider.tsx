/**
 * Slider Component
 *
 * A styled range-input slider with optional label and value display.
 * Uses CSS custom properties from variables.css.
 *
 * Usage:
 * <Slider
 *   label="Opacity"
 *   min={0} max={1} step={0.01}
 *   value={opacity}
 *   onChange={setOpacity}
 *   showValue
 *   formatValue={(v) => `${Math.round(v * 100)}%`}
 * />
 *
 * Self-contained fleet slider: the Radix slider composition (absorbed
 * from the retired src/components/ui/slider.tsx layer — the Root/Track/
 * Range/Thumb assembly with the size register, private CatalogSlider
 * below) now lives here; the header row (label + tabular value), the
 * wheel-to-change contract, and the disabled register are the app's and
 * live here.
 *
 * INTERACTION CONTRACT (bridge checklist #9 — documented override): the
 * pre-catalog primitive was a NATIVE <input type=range>; the catalog root
 * is a Radix Slider (the thumb owns role=slider). The public surface
 * preserves value/min/max/step/onChange(number); the documented deltas:
 * the ref targets the Root (a div, not the input) and the wheel handler
 * rides the Root's onWheel (same non-passive contract as the old JSX
 * handler).
 *
 * Legacy hook classes: `slider` / `slider--${size}` / `slider--disabled`
 * and the header hooks stay — feature CSS compounds on them.
 */
import { useCallback, useId, forwardRef, type InputHTMLAttributes, type WheelEvent, type CSSProperties, type ElementRef, type ComponentPropsWithoutRef } from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn.js';

/**
 * The catalog-slider composition (absorbed from the retired
 * src/components/ui/slider.tsx layer): the Radix Root/Track/Range/Thumb
 * assembly on the normalized token register — a 4px track on
 * outline-variant with the primary fill, a token-sized thumb (the
 * icon-xs canvas, the surface ring, the 1.15 hover grow) and the fleet
 * focus ring. The md size is the default; sm rides the
 * --slider-thumb-size-sm thumb and the --spacing-tiny track (the graph
 * settings register). Private to this file.
 */
const sliderVariants = cva("relative flex w-full touch-none select-none items-center", {
  variants: {
    size: {
      sm: "",
      md: "",
    },
  },
  defaultVariants: { size: "md" },
});

const TRACK_CLASSES: Record<"sm" | "md", string> = {
  sm: "h-tiny",
  md: "h-shape-sm",
};

const THUMB_CLASSES: Record<"sm" | "md", string> = {
  sm: "h-slider-thumb-sm w-slider-thumb-sm",
  md: "h-icon-xs w-icon-xs",
};

const CatalogSlider = forwardRef<
  ElementRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root> &
    VariantProps<typeof sliderVariants> & { "aria-label"?: string | undefined }
>(({ className, size = "md", "aria-label": ariaLabel, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn(sliderVariants({ size }), className)}
    {...props}
  >
    <SliderPrimitive.Track
      className={cn(
        "relative w-full grow overflow-hidden rounded-full bg-outline-variant",
        TRACK_CLASSES[size ?? "md"],
      )}
    >
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      aria-label={ariaLabel}
      className={cn(
        "block rounded-full border-thick border-solid border-surface bg-primary transition-[transform,background-color] duration-short ease-standard",
        "hover:scale-thumb-grow focus-visible:outline-none focus-visible:outline-offset-micro focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        THUMB_CLASSES[size ?? "md"],
      )}
    />
  </SliderPrimitive.Root>
));
CatalogSlider.displayName = SliderPrimitive.Root.displayName;

export type SliderSize = 'sm' | 'md';

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLDivElement>, 'onChange' | 'size' | 'type' | 'value' | 'defaultValue' | 'min' | 'max' | 'step'> {
  /** Current value */
  value: number;
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Step increment */
  step?: number;
  /** Called with the new numeric value on change */
  onChange: (value: number) => void;
  /** Optional label rendered above the track */
  label?: string;
  /** Show the current value next to the label */
  showValue?: boolean;
  /** Custom formatter for the displayed value */
  formatValue?: (value: number) => string;
  /** Size variant */
  size?: SliderSize;
  /** Disabled state */
  disabled?: boolean;
  /** Whether to allow changing the value via mouse wheel over the slider */
  scrollToChange?: boolean;
  /** Extra class on the root element */
  className?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  label,
  showValue = false,
  formatValue,
  size = 'md',
  disabled = false,
  scrollToChange = false,
  className = '',
  style,
  'aria-label': ariaLabel,
  ...rest
}: SliderProps) {
  const id = useId();

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!scrollToChange || disabled) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -step : step;
      const newValue = Math.max(min, Math.min(max, parseFloat((value + delta).toFixed(10))));
      onChange(newValue);
    },
    [scrollToChange, disabled, step, value, min, max, onChange],
  );

  const displayValue = formatValue ? formatValue(value) : String(value);

  return (
    <div
      className={cn(
        'slider flex w-full flex-col gap-1',
        `slider--${size}`,
        disabled && 'slider--disabled',
        className,
      )}
      style={style}
      onWheel={handleWheel}
      {...rest}
    >
      {(label || showValue) && (
        <div className="slider__header flex items-center justify-between gap-2">
          {label && (
            <span className="slider__label text-sm text-on-surface-variant" id={`${id}-label`}>
              {label}
            </span>
          )}
          {showValue && (
            <span className="slider__value min-w-slider-value text-right text-sm tabular-nums text-on-surface-variant">
              {displayValue}
            </span>
          )}
        </div>
      )}

      <div className="slider__track-wrapper relative flex w-full items-center">
        <CatalogSlider
          size={size}
          min={min}
          max={max}
          step={step}
          value={[value]}
          disabled={disabled}
          onValueChange={([next]) => {
            if (next !== undefined) onChange(next);
          }}
          aria-label={ariaLabel ?? label}
        />
      </div>
    </div>
  );
}
