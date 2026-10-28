/**
 * CodeTextarea
 *
 * A monospace multiline textarea for pasting structured or code-like content
 * (EDN, JSON, YAML, etc.). Provides error and valid visual states.
 * Supports forwarded refs for external focus management.
 *
 * Self-contained fleet code textarea: the native-textarea composition
 * (absorbed from the retired src/components/ui/textarea.tsx layer — the
 * normalized shadcn textarea, private CatalogTextarea below) now lives
 * here; the code register (mono family, the xs pitch on the 1.6 line, the
 * boxed surface, pre whitespace, the error/valid borders) is re-expressed
 * on top; the catalog's ring gives way to the fleet register (the global
 * app.css focus ring + the error ring thin shadow).
 *
 * Legacy hook classes: `code-textarea` (+ `code-textarea--error` /
 * `code-textarea--valid`) and `code-textarea-label` stay — feature CSS
 * compounds on them.
 */
import { useRef, useEffect, forwardRef, type KeyboardEvent, type RefObject, type ComponentProps } from 'react';

import { cn } from './cn.js';

/**
 * The catalog-textarea composition (absorbed from the retired
 * src/components/ui/textarea.tsx layer): the normalized shadcn textarea
 * — the theme-key utilities only, the focus ring from --ring, fleet
 * radii. Private to this file.
 */
const CatalogTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-button-lg w-full rounded-input border border-input bg-transparent px-3 py-2 text-base text-on-surface transition-colors duration-short ease-standard placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
CatalogTextarea.displayName = 'Textarea';

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
  /** Accessible label for the textarea */
  label?: string;
  /** ID used to associate the textarea with its label */
  id?: string;
  /** Blur passthrough (flush-and-exit surfaces). */
  onBlur?: (() => void) | undefined;
  /** Keyboard passthrough (Escape-to-exit surfaces). */
  onKeyDown?: ((event: KeyboardEvent<HTMLTextAreaElement>) => void) | undefined;
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
      label,
      id,
      onBlur,
      onKeyDown,
    },
    forwardedRef,
  ) {
    const internalRef = useRef<HTMLTextAreaElement>(null);
    const ref = (forwardedRef as RefObject<HTMLTextAreaElement>) ?? internalRef;

    useEffect(() => {
      if (autoFocus) {
        setTimeout(() => ref.current?.focus(), 0);
      }
      // intentionally only on mount
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <>
        {label && (
          <label htmlFor={id} className="code-textarea-label mb-2 block text-sm font-medium text-on-surface-variant">
            {label}
          </label>
        )}
        <CatalogTextarea
          ref={ref}
          id={id}
          className={cn(
            'code-textarea min-h-button-lg w-full resize-y whitespace-pre border-outline-variant bg-surface p-3 font-mono text-xs leading-code text-on-surface tab-2',
            'transition-colors duration-shorter ease-standard placeholder:text-on-surface-variant/50',
            'focus-visible:ring-0',
            error && 'code-textarea--error border-error focus-visible:shadow-error-ring-thin',
            !error && valid && 'code-textarea--valid border-primary',
            disabled && 'cursor-not-allowed resize-none opacity-50',
            className,
          )}
          style={minHeight != null ? { minHeight } : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={spellCheck}
          aria-label={label ? undefined : 'Code input'}
        />
      </>
    );
  },
);
