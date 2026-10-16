/**
 * Input — the boxed text field: the SelectTrigger register applied to a
 * native <input> (a quiet bordered field on the base surface, the trailing
 * affordance absent — free text, no choices). Pairs with Dropdown in dense
 * condition/toolbar rows where the underline TextField register would read
 * as a different control family. The global input focus ring
 * (app.css --shadow-focus-ring) carries focus; hover lifts the border a
 * step, disabled halves the opacity.
 */

import { forwardRef, type InputHTMLAttributes } from 'react';

import './Input.css';

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
  const classes = [
    'input',
    `input--${size}`,
    error && 'input--error',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <input ref={ref} className={classes} {...props} />;
});
