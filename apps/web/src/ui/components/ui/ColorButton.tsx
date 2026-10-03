/**
 * ColorButton Component
 *
 * A button that displays as a solid color swatch.
 * Styled like Button, but shows a filled color instead of an icon.
 * Has a gap between the color fill and the button border.
 *
 * Supports preset tokens (`"sky"`), custom hex colors (`#RRGGBB`), and —
 * for display only — the retired `var(--color-preset-*)` encoding (folded to
 * its token by colorPresets). The picker stores preset tokens so themes can
 * remap them without touching node data.
 *
 * Usage:
 *   <ColorButton color="sky" onClick={handleClick} />
 *   <ColorButton color="sky" showPicker onColorChange={handleChange} />
 *   <ColorButton color={myColor} showPicker colors={myPalette} onColorChange={handleChange} />
 */
import { forwardRef, useState, useRef, useEffect, useLayoutEffect, type ButtonHTMLAttributes, type ChangeEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button.js';
import { TextField } from './TextField.js';
import { observeResizes } from './overlay-hooks.js';
import { PRESET_COLOR_ENTRIES, canonicalColor, cssColorFor } from './colorPresets.js';
import './ColorButton.css';

export type ColorButtonSize = 'xs' | 'sm' | 'md' | 'lg';

/** A color entry for the picker palette. */
export interface ColorEntry {
  /** Stored value emitted when the swatch is selected (preset token or hex). */
  value: string;
  /** Human-readable label shown as tooltip */
  label: string;
}

// Default built-in data palette.
const DEFAULT_COLOR_ENTRIES: ColorEntry[] = PRESET_COLOR_ENTRIES;

/** Space between the button and the picker popover. */
const PICKER_GAP = 4;
/** Minimum clearance from the picker to the viewport edge. */
const VIEWPORT_MARGIN = 16;

function isValidHexColor(color: string): boolean {
  return /^#?([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
}

function normalizeHex(color: string): string {
  return `#${color.replace('#', '')}`;
}

/** Internal non-forwarded swatch used inside the picker popover. */
function ColorSwatch({
  color,
  size = 'sm',
  active = false,
  className = '',
  disabled,
  title,
  'aria-label': ariaLabel,
  ...props
}: Omit<ColorButtonProps, 'showPicker' | 'showNoneOption' | 'colors' | 'onColorChange'>) {
  const classNames = [
    'color-btn',
    `color-btn--${size}`,
    active && 'color-btn--active',
    disabled && 'color-btn--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      className={classNames}
      disabled={disabled}
      type="button"
      title={title}
      aria-label={ariaLabel ?? title}
      {...props}
    >
      <span className="color-btn__fill" style={{ backgroundColor: cssColorFor(color) }} />
    </button>
  );
}

export interface ColorButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange'> {
  /** The color to display — hex string */
  color: string;
  /** Size of the button (matches Button sizes) */
  size?: ColorButtonSize;
  /** Whether the button is in an active/selected state */
  active?: boolean;
  /** Show color picker popover on click */
  showPicker?: boolean;
  /** Add a "· no color" entry at the start of the palette that emits null */
  showNoneOption?: boolean;
  /**
   * Custom color palette for the picker.
   * Defaults to the built-in preset palette.
   * Each entry emits its cssVar string when selected.
   */
  colors?: ColorEntry[];
  /** Called with a palette swatch's value, a hex string for the custom input, or null for "no color". */
  onColorChange?: (color: string | null) => void;
}

export const ColorButton = forwardRef<HTMLButtonElement, ColorButtonProps>(function ColorButton(
  {
    color,
    size = 'sm',
    active = false,
    className = '',
    disabled,
    showPicker = false,
    showNoneOption = false,
    colors,
    onColorChange,
    onClick,
    ...props
  },
  ref
) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [hexInput, setHexInput] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const palette = colors ?? DEFAULT_COLOR_ENTRIES;

  // Position the picker below the button (flipping above when there is not
  // enough room) and keep it inside the viewport. Styles are written straight
  // to the picker element, so repositioning never goes through React renders.
  // Scroll (any ancestor), viewport resize, and element resize re-trigger
  // positioning — the same imperative pattern as ContextMenu.
  useLayoutEffect(() => {
    if (!isPickerOpen) return;
    const reference = buttonRef.current;
    const floating = pickerRef.current;
    if (!reference || !floating) return;

    const update = () => {
      const referenceRect = reference.getBoundingClientRect();
      const floatingW = floating.offsetWidth;
      const floatingH = floating.offsetHeight;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      // Vertical: prefer below the button, flip above when there is not
      // enough room and more space on top.
      const spaceBelow = viewportH - referenceRect.bottom - PICKER_GAP - VIEWPORT_MARGIN;
      const spaceAbove = referenceRect.top - PICKER_GAP - VIEWPORT_MARGIN;
      let y: number;
      if (spaceBelow < floatingH && spaceAbove > spaceBelow) {
        y = referenceRect.top - floatingH - PICKER_GAP;
      } else {
        y = referenceRect.bottom + PICKER_GAP;
      }
      y = Math.min(Math.max(y, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportH - floatingH - VIEWPORT_MARGIN));

      // Horizontal: start (left) aligned, then clamp.
      const x = Math.min(
        Math.max(referenceRect.left, VIEWPORT_MARGIN),
        Math.max(VIEWPORT_MARGIN, viewportW - floatingW - VIEWPORT_MARGIN),
      );

      floating.style.left = `${x}px`;
      floating.style.top = `${y}px`;
      floating.style.visibility = 'visible';
    };

    update();

    const handleReposition = () => update();
    window.addEventListener('scroll', handleReposition, { capture: true, passive: true });
    window.addEventListener('resize', handleReposition);
    const unobserve = observeResizes([reference, floating], handleReposition);

    return () => {
      window.removeEventListener('scroll', handleReposition, { capture: true });
      window.removeEventListener('resize', handleReposition);
      unobserve();
    };
  }, [isPickerOpen]);

  useEffect(() => {
    if (!isPickerOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        pickerRef.current &&
        buttonRef.current &&
        !pickerRef.current.contains(e.target as Node) &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsPickerOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isPickerOpen]);

  const handleColorSelect = (selectedColor: string | null) => {
    onColorChange?.(selectedColor);
    setIsPickerOpen(false);
  };

  const handleHexChange = (e: ChangeEvent<HTMLInputElement>) => {
    setHexInput(e.target.value.replace('#', ''));
  };

  const handleHexApply = () => {
    const withHash = normalizeHex(hexInput);
    if (isValidHexColor(withHash)) {
      onColorChange?.(withHash);
      setIsPickerOpen(false);
      setHexInput('');
    }
  };

  const handleButtonClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (showPicker) {
      setIsPickerOpen(!isPickerOpen);
    } else {
      onClick?.(e);
    }
  };

  const isHexValid = isValidHexColor(hexInput);
  const previewColor = isHexValid ? normalizeHex(hexInput) : 'var(--color-disabled)';

  const classNames = [
    'color-btn',
    `color-btn--${size}`,
    active && 'color-btn--active',
    disabled && 'color-btn--disabled',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button
        ref={(node) => {
          buttonRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        className={classNames}
        disabled={disabled}
        onClick={handleButtonClick}
        {...props}
      >
        <span
          className="color-btn__fill"
          style={{ backgroundColor: cssColorFor(color) }}
        />
      </button>

      {showPicker && isPickerOpen && createPortal(
        <div
          ref={pickerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Color picker"
          className="color-btn-picker"
          onClickCapture={(e) => e.stopPropagation()}
          onMouseDownCapture={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            // top/left are set imperatively by the positioning effect; hidden
            // until the first pass has positioned the picker
            visibility: 'hidden',
            zIndex: 'var(--z-tooltip)',
          }}
        >
          <div className="color-btn-picker__grid">
            {palette.map(({ value, label }) => (
              <ColorSwatch
                key={value}
                color={cssColorFor(value)}
                size="xs"
                active={canonicalColor(color) === canonicalColor(value)}
                title={label}
                aria-label={label}
                onClick={(e) => {
                  e.stopPropagation();
                  handleColorSelect(value);
                }}
              />
            ))}
          </div>

          <div className="color-btn-picker__custom">
            <TextField
              size="md"
              value={hexInput}
              onChange={handleHexChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isHexValid) {
                  handleHexApply();
                }
              }}
              placeholder="3b82f6"
              maxLength={6}
              error={hexInput.length > 0 && !isHexValid}
              style={{ fontFamily: 'var(--font-family-mono)' }}
            />
            <ColorSwatch
              color={previewColor}
              size="xs"
              active={isHexValid}
              disabled={!isHexValid}
              title={isHexValid ? 'Apply' : 'Invalid hex'}
              aria-label={isHexValid ? 'Apply color' : 'Invalid hex color'}
              onClick={(e) => {
                e.stopPropagation();
                if (isHexValid) handleHexApply();
              }}
            />
            {showNoneOption && (
              <Button aria-label="Remove color"
                variant="ghost"
                size="sm"
                icon={"mdi mdi-trash-can-outline"}
                title="Remove color"
                onClick={(e) => {
                  e.stopPropagation();
                  handleColorSelect(null);
                }}
              />
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
});
