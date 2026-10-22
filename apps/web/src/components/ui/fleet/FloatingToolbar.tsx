/**
 * FloatingToolbar Component
 *
 * The floating panel for transient toolbars — the selection formatting
 * bar, floating action rows. One elevated panel hosting a single row of
 * fleet `Button`s (compose `ToolbarDivider` between button groups).
 *
 * Presentational only: positioning and anchoring stay with the caller.
 * The editor's selection toolbar portals itself to document.body and
 * writes top/left imperatively against the live selection Range, so the
 * ref, style, and aria attributes forward straight through the panel
 * root (see ui/editor-popups/FloatingToolbar.tsx).
 */
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.js';
import './FloatingToolbar.css';

export interface FloatingToolbarProps extends HTMLAttributes<HTMLDivElement> {
  /** Toolbar actions — fleet `Button`s and `ToolbarDivider`s. */
  children: ReactNode;
}

/**
 * FloatingToolbar — an elevated row-of-buttons panel that floats over
 * content. The visible height rides the buttons' size token; the panel
 * adds the padding, corner, border, and shadow of the popup register.
 */
export const FloatingToolbar = forwardRef<HTMLDivElement, FloatingToolbarProps>(
  function FloatingToolbar({ children, className = '', ...rest }, ref) {
    return (
      <div ref={ref} className={cn('floating-toolbar', className)} {...rest}>
        {children}
      </div>
    );
  },
);
