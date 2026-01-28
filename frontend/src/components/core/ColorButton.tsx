/**
 * ColorButton Component
 * 
 * A button that displays as a solid color swatch.
 * Styled like Button, but shows a filled color instead of an icon.
 * Has a gap between the color fill and the button border.
 * 
 * Can optionally show a color picker popover when clicked.
 * 
 * Usage:
 * <ColorButton color="#ff5722" onClick={handleClick} />
 * <ColorButton color="#ff5722" showPicker onColorChange={handleChange} />
 */
import { forwardRef, useState, useRef, useEffect, useCallback, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import './ColorButton.css';

export type ColorButtonSize = 'xs' | 'sm' | 'md' | 'lg';

// System highlight colors from variables.css
const PRESET_COLOR_VARS = [
  '--color-preset-red',
  '--color-preset-orange',
  '--color-preset-yellow',
  '--color-preset-green',
  '--color-preset-teal',
  '--color-preset-blue',
  '--color-preset-purple',
  '--color-preset-pink',
] as const;

function getCSSVariableValue(varName: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function isValidHexColor(color: string): boolean {
  return /^#?([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
}

function normalizeHex(color: string): string {
  const cleaned = color.replace('#', '');
  return `#${cleaned}`;
}

export interface ColorButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onChange'> {
  /** The color to display (hex, rgb, or named color) */
  color: string;
  /** Size of the button (matches Button sizes) */
  size?: ColorButtonSize;
  /** Whether the button is in an active/selected state */
  active?: boolean;
  /** Show color picker on click */
  showPicker?: boolean;
  /** Callback when color changes (only used with showPicker) */
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

  const presetColors = PRESET_COLOR_VARS.map(varName => ({
    varName,
    hex: getCSSVariableValue(varName) || '#808080'
  }));

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

  const handleColorSelect = (selectedColor: string) => {
    onColorChange?.(selectedColor);
    setIsPickerOpen(false);
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value.replace('#', '');
    setHexInput(value);
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
          style={{
            position: 'fixed',
            top: `${pickerPosition.top}px`,
            left: `${pickerPosition.left}px`,
            zIndex: 10000,
          }}
        >
          <div className="color-btn-picker__grid">
            {presetColors.map(({ varName, hex }) => (
              <button
                key={varName}
                className={`color-btn-picker__swatch ${color === hex ? 'selected' : ''}`}
                style={{ backgroundColor: `var(${varName})` }}
                onClick={() => handleColorSelect(hex)}
                title={hex}
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
              onClick={isHexValid ? handleHexApply : undefined}
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
