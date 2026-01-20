/**
 * ButtonWithText Component
 *
 * A composite component that combines a Button with a text input field.
 * The button and input have the same height and the input spans remaining space.
 * Useful for color inputs, search with action, etc.
 */
import { forwardRef } from 'react';
import './ButtonWithText.css';

export interface ButtonWithTextProps {
  /** Value of the text input */
  value: string;
  /** Called when input value changes */
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Called on key down */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Button position relative to input */
  buttonPosition?: 'left' | 'right';
  /** Custom button element to render */
  buttonContent?: React.ReactNode;
  /** Whether the button is visible */
  showButton?: boolean;
  /** Input type */
  inputType?: 'text' | 'search' | 'email' | 'url';
  /** Max length for input */
  maxLength?: number;
  /** Whether input is disabled */
  disabled?: boolean;
  /** Size variant */
  size?: 'xs' | 'sm' | 'md';
  /** Additional className for container */
  className?: string;
  /** Additional className for input */
  inputClassName?: string;
}

export const ButtonWithText = forwardRef<HTMLInputElement, ButtonWithTextProps>(
  function ButtonWithText(
    {
      value,
      onChange,
      onKeyDown,
      placeholder = '',
      buttonPosition = 'left',
      buttonContent,
      showButton = true,
      inputType = 'text',
      maxLength,
      disabled = false,
      size = 'sm',
      className = '',
      inputClassName = '',
    },
    ref
  ) {
    const renderButton = () => {
      if (!showButton || !buttonContent) return null;
      
      return (
        <div className="btn-with-text__button-wrapper">
          {buttonContent}
        </div>
      );
    };

    return (
      <div
        className={`btn-with-text btn-with-text--${size} btn-with-text--${buttonPosition} ${showButton ? '' : 'btn-with-text--no-button'} ${className}`}
      >
        {buttonPosition === 'left' && renderButton()}
        <input
          ref={ref}
          type={inputType}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={disabled}
          className={`btn-with-text__input ${inputClassName}`}
        />
        {buttonPosition === 'right' && renderButton()}
      </div>
    );
  }
);

export default ButtonWithText;
