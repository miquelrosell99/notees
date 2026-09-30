/**
 * AddPill — dashed ghost pill button that appends a chip to a group.
 *
 * The "+ Add class" / "+ Add tag" / "+ Add" affordance in metadata sections:
 * composes the Pill base look with the `pill--add` dashed modifier.
 */

import { forwardRef, type ReactNode, type MouseEvent } from 'react';
import { Icon } from '../../Icon.js';
import { cn } from './cn.js';
import './Pill.css';

export interface AddPillProps {
  /** Called when the pill is clicked. Receives the button element. */
  onClick: (element: HTMLButtonElement) => void;
  /** Pill label (e.g. "Add class"); the leading "+" is rendered by the primitive. */
  label: string;
  /** Additional className on the button. */
  className?: string;
  /** Optional extra content rendered after the label. */
  children?: ReactNode;
  'aria-expanded'?: boolean | undefined;
  disabled?: boolean;
}

export const AddPill = forwardRef<HTMLButtonElement, AddPillProps>(function AddPill(
  { onClick, label, className = '', children, ...props },
  ref,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    onClick(e.currentTarget);
  };

  return (
    <button
      ref={ref}
      type="button"
      className={cn('pill', 'pill--add', className)}
      onClick={handleClick}
      {...props}
    >
      <span className="pill__left-icon">
        <Icon path="mdi mdi-plus" size={0.75} />
      </span>
      <span className="pill__text">{label}</span>
      {children}
    </button>
  );
});
