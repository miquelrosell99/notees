/**
 * Input — the boxed text field: the SelectTrigger register applied to a
 * native <input> (a quiet bordered field on the base surface, the trailing
 * affordance absent — free text, no choices). Pairs with Dropdown in dense
 * condition/toolbar rows where the underline TextField register would read
 * as a different control family. The global input focus ring
 * (app.css --shadow-focus-ring) carries focus; hover lifts the border a
 * step, disabled halves the opacity.
 *
 * Thin fleet wrapper over the normalized catalog input
 * (src/components/ui/input.tsx): the fleet register (the boxed surface,
 * the sm/md row heights, the error border) is re-expressed on top; the
 * catalog's fixed height and placeholder give way to the fleet's
 * min-height + padding scale and placeholder opacity.
 *
 * Legacy hook classes: `input` / `input--${size}` / `input--error` stay
 * on the root so feature CSS that compounds on them keeps matching.
 */

import { forwardRef, type InputHTMLAttributes } from 'react';

import { Input as CatalogInput } from '@/components/ui/input';
import { cn } from './cn';

export type InputSize = 'sm' | 'md';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Size variant — sm rides the compact --height-md row register. */
  size?: InputSize | undefined;
  /** Error state — the border takes the error token. */
  error?: boolean | undefined;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', error = false, className = '', ...props },
  ref,
) {
  return (
    <CatalogInput
      ref={ref}
      className={cn(
        'input bg-surface text-on-surface transition-colors duration-short ease-standard',
        'h-auto border-outline-variant placeholder:text-on-surface-variant/70',
        'hover:enabled:border-outline disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'input--sm min-h-md px-3' : 'input--md min-h-lg px-4',
        error && 'input--error border-error',
        className,
      )}
      {...props}
    />
  );
});
