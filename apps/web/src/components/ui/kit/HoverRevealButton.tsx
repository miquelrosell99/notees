/**
 * HoverRevealButton — a zero-footprint affordance that expands in place.
 *
 * The button collapses to zero width (its negative margin cancels the
 * leading gap, so the row keeps the exact footprint of one without the
 * affordance — the surviving trail gap reads as the neighbor gap) and fades
 * out at rest. Hovering anywhere in the surrounding `.ui-hover-reveal-group`
 * container, keyboard focus, or an anchored popup left open (`aria-expanded`
 * on the trigger) expands it to a square hit target with the standard short
 * width/height + opacity motion.
 *
 * Built for split-button chevrons and trail affordances — the topbar undo
 * cluster's history chevron and the breadcrumb trails' parent-edit chevron
 * compose it (the trails were the pattern's origin).
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';

import { cn } from './cn.js';
import './HoverRevealButton.css';

export type HoverRevealButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  children: ReactNode;
  className?: string | undefined;
};

export const HoverRevealButton = forwardRef<HTMLButtonElement, HoverRevealButtonProps>(
  function HoverRevealButton(
    { children, className = '', type = 'button', ...props }: HoverRevealButtonProps,
    ref: Ref<HTMLButtonElement>,
  ) {
    return (
      <button ref={ref} type={type} className={cn('ui-hover-reveal', className)} {...props}>
        {children}
      </button>
    );
  },
);
