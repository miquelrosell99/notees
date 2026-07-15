/**
 * ColorButton Component
 *
 * A button that displays as a solid color swatch.
 * Styled like Button, but shows a filled color instead of an icon.
 * Has a gap between the color fill and the button border.
 *
 * Supports both hex colors and CSS variable references (e.g. 'var(--color-preset-red)').
 * CSS variable references are stored and emitted as-is, keeping colors theme-aware.
 *
 * Usage:
 *   <ColorButton color="#ff5722" onClick={handleClick} />
 *   <ColorButton color="var(--color-preset-red)" showPicker onColorChange={handleChange} />
 *   <ColorButton color={myColor} showPicker colors={myPalette} onColorChange={handleChange} />
 */
import { forwardRef, useState, useRef, useEffect, useLayoutEffect, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Button } from './Button';
import { TextField } from './TextField';
import { PRESET_COLOR_ENTRIES } from '@/utils/colorPresets';
import './ColorButton.css';

export type ColorButtonSize = 'xs' | 'sm' | 'md' | 'lg';

/** A color entry for the picker palette. Store colors as CSS variable references for theme-awareness. */
export interface ColorEntry {
  /** CSS variable reference, e.g. 'var(--color-preset-red)' */
  cssVar: string;
  /** Human-readable label shown as tooltip */
  label: string;
}

// Default built-in palette from data-colors.css
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
      <span className="color-btn__fill" style={{ backgroundColor: color }} />
    </button>
  );
}

export interface ColorButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange'> {
  /** The color to display — hex or CSS variable reference like 'var(--color-preset-red)' */
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
  /** Called with a CSS var reference for palette swatches, a hex string for the custom input, or null for "no color". */
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

  // Position the picker with Floating UI and keep it anchored to the button.
  // autoUpdate repositions on scroll (any ancestor), resize, element resize,
  // and layout shifts; styles are written straight to the picker element, so
  // repositioning never goes through React renders.
  useLayoutEffect(() => {
    if (!isPickerOpen) return;
    const reference = buttonRef.current;
    const floating = pickerRef.current;
    if (!reference || !floating) return;

    const update = () => {
      computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(PICKER_GAP),
          flip({ padding: VIEWPORT_MARGIN, fallbackPlacements: ['top-start'] }),
          shift({ padding: VIEWPORT_MARGIN, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.visibility = 'visible';
      });
    };

    update();
    return autoUpdate(reference, floating, update);
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

  const handleColorSelect = (cssVar: string) => {
    onColorChange?.(cssVar);
    setIsPickerOpen(false);
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  const handleButtonClick = (e: React.MouseEvent<HTMLButtonElement>) => {
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
          style={{ backgroundColor: color }}
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
            // top/left are set imperatively by Floating UI; hidden until the
            // first computePosition has positioned the picker
            visibility: 'hidden',
            zIndex: 'var(--z-tooltip)',
          }}
        >
          <div className="color-btn-picker__grid">
            {palette.map(({ cssVar, label }) => (
              <ColorSwatch
                key={cssVar}
                color={cssVar}
                size="xs"
                active={color === cssVar}
                title={label}
                aria-label={label}
                onClick={(e) => {
                  e.stopPropagation();
                  handleColorSelect(cssVar);
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
                  onColorChange?.(null);
                  setIsPickerOpen(false);
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

