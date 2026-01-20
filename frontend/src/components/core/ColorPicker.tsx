/**
 * ColorPicker Component
 *
 * A color picker element using ButtonWithPanel for consistent UI.
 * Provides preset color swatches (themed via CSS variables) and custom hex input.
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { mdiCheck } from '@mdi/js';
import { ButtonWithPanel } from './ButtonWithPanel';
import { Button } from './Button';
import { ButtonWithText } from './ButtonWithText';
import './ColorPicker.css';

// Preset colors using CSS variable names - these reference themed colors from variables.css
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

// Helper to get computed CSS variable value
function getCSSVariableValue(varName: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

// Check if a string is a valid hex color
function isValidHexColor(color: string): boolean {
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
}

interface ColorPickerProps {
  /** Currently selected color (hex string) */
  value: string | null;
  /** Called when a color is selected */
  onChange: (color: string | null) => void;
  /** Button size */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Panel position */
  panelPosition?: 'left' | 'right' | 'top' | 'bottom';
  /** Whether to show "no color" option */
  showNoColor?: boolean;
  /** Whether to show custom color input */
  showCustom?: boolean;
  /** Button tooltip */
  tooltip?: string;
  /** Whether picker is disabled */
  disabled?: boolean;
  /** Additional className for the container */
  className?: string;
  /** Custom trigger element - if provided, replaces the default button */
  trigger?: React.ReactNode;
}

export function ColorPicker({
  value,
  onChange,
  size = 'sm',
  panelPosition = 'bottom',
  showNoColor = true,
  showCustom = true,
  tooltip = 'Choose color',
  disabled = false,
  className = '',
  trigger,
}: ColorPickerProps) {
  const [customHex, setCustomHex] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Get the actual hex values from CSS variables
  const presetColors = useMemo(() => {
    return PRESET_COLOR_VARS.map(varName => ({
      varName,
      hex: getCSSVariableValue(varName) || '#808080'
    }));
  }, []);

  // Refresh preset colors when theme might change
  useEffect(() => {
    const observer = new MutationObserver(() => {
      // Force re-render when data-theme changes
      setCustomHex(prev => prev);
    });
    observer.observe(document.documentElement, { 
      attributes: true, 
      attributeFilter: ['data-theme', 'class'] 
    });
    return () => observer.disconnect();
  }, []);

  const handleColorSelect = useCallback((color: string | null) => {
    onChange(color);
    setIsOpen(false);
  }, [onChange]);

  const handleCustomHexChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    let hex = e.target.value;
    // Auto-add # if user starts typing without it
    if (hex && !hex.startsWith('#')) {
      hex = '#' + hex;
    }
    setCustomHex(hex);
  }, []);

  const handleCustomHexApply = useCallback(() => {
    if (isValidHexColor(customHex)) {
      onChange(customHex);
      setIsOpen(false);
      setCustomHex('');
    }
  }, [customHex, onChange]);

  const isCustomHexValid = isValidHexColor(customHex);

  // Determine the trigger content
  const triggerContent = trigger ? (
    <div className="color-picker-custom-trigger">
      {trigger}
    </div>
  ) : (
    // Default trigger: a color swatch showing the current color
    <span 
      className="color-picker-default-trigger"
      style={value ? { backgroundColor: value } : undefined}
      title={tooltip}
    >
      {!value && <span className="color-picker-no-color-line" />}
    </span>
  );

  return (
    <div className={`color-picker ${className}`} ref={containerRef}>
      <ButtonWithPanel
        icon={undefined}
        variant="ghost"
        size={size}
        panelPosition={panelPosition}
        panelAlignment="start"
        panelWidth={220}
        open={isOpen}
        onOpenChange={setIsOpen}
        tooltip={tooltip}
        disabled={disabled}
        buttonClassName="color-picker-btn"
        panelClassName="color-picker-panel"
        customTrigger={triggerContent}
      >
        <div className="color-picker-content">
          {/* No color option */}
          {showNoColor && (
            <button
              className={`color-picker-no-color ${!value ? 'selected' : ''}`}
              onClick={() => handleColorSelect(null)}
              title="Remove color"
            >
              <span className="color-picker-no-color-swatch">
                <span className="color-picker-no-color-line" />
              </span>
              <span>No color</span>
            </button>
          )}

          {/* Preset color swatches */}
          <div className="color-picker-section">
            <span className="color-picker-section-label">Colors</span>
            <div className="color-picker-preset-grid">
              {presetColors.map(({ varName, hex }) => (
                <button
                  key={varName}
                  className={`color-picker-preset-swatch ${value === hex ? 'selected' : ''}`}
                  style={{ backgroundColor: `var(${varName})` }}
                  onClick={() => handleColorSelect(hex)}
                  title={hex}
                />
              ))}
            </div>
          </div>

          {/* Custom hex input with ButtonWithText */}
          {showCustom && (
            <div className="color-picker-custom-section">
              <ButtonWithText
                size="sm"
                buttonPosition="left"
                showButton={isCustomHexValid}
                value={customHex}
                onChange={handleCustomHexChange}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isCustomHexValid) {
                    handleCustomHexApply();
                  }
                }}
                placeholder="#3b82f6"
                maxLength={7}
                buttonContent={
                  <Button
                    icon={mdiCheck}
                    size="sm"
                    variant="primary"
                    onClick={handleCustomHexApply}
                    disabled={!isCustomHexValid}
                    title="Apply custom color"
                    className="color-picker-apply-btn"
                    style={isCustomHexValid ? { 
                      backgroundColor: customHex,
                      borderColor: customHex 
                    } : undefined}
                  />
                }
              />
            </div>
          )}
        </div>
      </ButtonWithPanel>
    </div>
  );
}

/**
 * Inline color swatch button for compact use
 */
interface ColorSwatchProps {
  color: string | null;
  onClick?: () => void;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function ColorSwatch({
  color,
  onClick,
  size = 'sm',
  className = '',
}: ColorSwatchProps) {
  const sizeClass = `color-swatch--${size}`;

  if (!color) {
    return (
      <button
        className={`color-swatch color-swatch--none ${sizeClass} ${className}`}
        onClick={onClick}
        title="No color"
      >
        <span className="color-swatch-line" />
      </button>
    );
  }

  return (
    <button
      className={`color-swatch ${sizeClass} ${className}`}
      style={{ backgroundColor: color }}
      onClick={onClick}
      title={color}
    />
  );
}

export default ColorPicker;
