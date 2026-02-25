/**
 * CodeTextarea
 *
 * A monospace multiline textarea for pasting structured or code-like content
 * (EDN, JSON, YAML, etc.). Provides error and valid visual states.
 * Supports forwarded refs for external focus management.
 */
import { useRef, useEffect, forwardRef } from 'react';
import './CodeTextarea.css';

interface CodeTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Highlight with error border */
  error?: boolean;
  /** Highlight with success/primary border */
  valid?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  spellCheck?: boolean;
  className?: string;
  /** Minimum pixel height */
  minHeight?: number;
}

export const CodeTextarea = forwardRef<HTMLTextAreaElement, CodeTextareaProps>(
  function CodeTextarea(
    {
      value,
      onChange,
      placeholder,
      error,
      valid,
      autoFocus,
      disabled,
      spellCheck = false,
      className = '',
      minHeight,
    },
    forwardedRef,
  ) {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const ref = (forwardedRef as React.RefObject<HTMLTextAreaElement>) ?? internalRef;

    useEffect(() => {
      if (autoFocus) {
        setTimeout(() => ref.current?.focus(), 0);
      }
      // intentionally only on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const cls = [
      'code-textarea',
      error ? 'code-textarea--error' : '',
      valid ? 'code-textarea--valid' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <textarea
        ref={ref}
        className={cls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={spellCheck}
        style={minHeight != null ? { minHeight } : undefined}
      />
    );
  },
);

export default CodeTextarea;
