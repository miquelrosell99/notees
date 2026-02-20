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
import { forwardRef, useState, useRef, useEffect, useCallback, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import './ColorButton.css';

export type ColorButtonSize = 'xs' | 'sm' | 'md' | 'lg';

/** A color entry for the picker palette. Store colors as CSS variable references for theme-awareness. */
export interface ColorEntry {
  /** CSS variable reference, e.g. 'var(--color-preset-red)' */
  cssVar: string;
  /** Human-readable label shown as tooltip */
  label: string;
}

// Default built-in palette from variables.css
const DEFAULT_COLOR_ENTRIES: ColorEntry[] = [
  { cssVar: 'var(--color-preset-red)',    label: 'Red' },
  { cssVar: 'var(--color-preset-orange)', label: 'Orange' },
  { cssVar: 'var(--color-preset-yellow)', label: 'Yellow' },
  { cssVar: 'var(--color-preset-green)',  label: 'Green' },
  { cssVar: 'var(--color-preset-teal)',   label: 'Teal' },
  { cssVar: 'var(--color-preset-blue)',   label: 'Blue' },
  { cssVar: 'var(--color-preset-purple)', label: 'Purple' },
  { cssVar: 'var(--color-preset-pink)',   label: 'Pink' },
];

function isValidHexColor(color: string): boolean {
  return /^#?([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
}

function normalizeHex(color: string): string {
  return `#${color.replace('#', '')}`;
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
  /**
   * Custom color palette for the picker.
   * Defaults to the built-in preset palette.
   * Each entry emits its cssVar string when selected.
   */
  colors?: ColorEntry[];
  /** Called with a CSS var reference for palette swatches, or a hex string for the custom input. */
  onColorChange?: (color: string) => void;
}

export const ColorButton = forwardRef<HTMLButtonElement, ColorButtonProps>(function ColorButton(
  {
    color,
    size = 'sm',
    active = false,
    className = '',
    disabled,
    showPicker = false,
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

    // Default: right and bottom of button
    let left = buttonRect.right + 8;
    let top = buttonRect.bottom + 8;

    // Check if it fits on the right, otherwise move to left
    if (left + pickerRect.width > viewportWidth - 16) {
      left = buttonRect.left - pickerRect.width - 8;
    }

    // Check if it fits on the bottom, otherwise move to top
    if (top + pickerRect.height > viewportHeight - 16) {
      top = buttonRect.top - pickerRect.height - 8;
    }

    // Clamp to viewport
    left = Math.max(16, Math.min(left, viewportWidth - pickerRect.width - 16));
    top = Math.max(16, Math.min(top, viewportHeight - pickerRect.height - 16));

    setPickerPosition({ top, left });
  }, []);

  useEffect(() => {
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
          className="color-btn-picker"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: `${pickerPosition.top}px`,
            left: `${pickerPosition.left}px`,
            zIndex: 10000,
          }}
        >
          <div className="color-btn-picker__grid">
            {palette.map(({ cssVar, label }) => (
              <button
                key={cssVar}
                className={`color-btn-picker__swatch ${color === cssVar ? 'selected' : ''}`}
                style={{ backgroundColor: cssVar }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleColorSelect(cssVar);
                }}
                title={label}
                type="button"
              />
            ))}
          </div>

          <div className="color-btn-picker__custom">
            <input
              type="text"
              value={hexInput}
              onChange={handleHexChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isHexValid) {
                  handleHexApply();
                }
              }}
              placeholder="3b82f6"
              maxLength={6}
              className="color-btn-picker__input"
            />
            <button
              type="button"
              className={`color-btn color-btn--sm ${!isHexValid ? 'color-btn--disabled' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (isHexValid) handleHexApply();
              }}
              disabled={!isHexValid}
              title={isHexValid ? 'Apply' : 'Invalid hex'}
            >
              <span 
                className="color-btn__fill"
                style={{ backgroundColor: previewColor }}
              />
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
});

export default ColorButton;
