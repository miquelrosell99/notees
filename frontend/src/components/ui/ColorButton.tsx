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
import { forwardRef, useState, useRef, useEffect, useLayoutEffect, useCallback, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
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
    <button className={classNames} disabled={disabled} type="button" {...props}>
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
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const palette = colors ?? DEFAULT_COLOR_ENTRIES;

  const calculatePosition = useCallback(() => {
    if (!buttonRef.current || !pickerRef.current) return;

    const buttonRect = buttonRef.current.getBoundingClientRect();
    const pickerRect = pickerRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Align left edge of picker to left edge of button, below it
    let left = buttonRect.left;
    let top = buttonRect.bottom + 4;

    // If it overflows the right viewport edge, shift left to fit
    if (left + pickerRect.width > viewportWidth - 16) {
      left = viewportWidth - pickerRect.width - 16;
    }

    // Check if it fits on the bottom, otherwise move to top
    if (top + pickerRect.height > viewportHeight - 16) {
      top = buttonRect.top - pickerRect.height - 4;
    }

    // Clamp to viewport
    left = Math.max(16, left);
    top = Math.max(16, top);

    setPickerPosition({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (isPickerOpen) {
      calculatePosition();
      window.addEventListener('resize', calculatePosition);
      window.addEventListener('scroll', calculatePosition, true);
      return () => {
        window.removeEventListener('resize', calculatePosition);
        window.removeEventListener('scroll', calculatePosition, true);
      };
    }
  }, [isPickerOpen, calculatePosition]);

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
  const previewColor = isHexValid ? normalizeHex(hexInput) : '#808080';

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
            top: `${pickerPosition.top}px`,
            left: `${pickerPosition.left}px`,
            zIndex: 10003,
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
              style={{ fontFamily: "'Consolas', 'Monaco', monospace" }}
            />
            <ColorSwatch
              color={previewColor}
              size="xs"
              active={isHexValid}
              disabled={!isHexValid}
              title={isHexValid ? 'Apply' : 'Invalid hex'}
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

