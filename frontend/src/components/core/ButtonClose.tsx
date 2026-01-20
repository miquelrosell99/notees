/**
 * ButtonClose Component
 * 
 * A specialized close button component based on the Button component.
 * Used for dismissing modals, panels, sidebars, and other closable UI elements.
 * 
 * Usage:
 * - Basic: <ButtonClose onClick={handleClose} />
 * - With title: <ButtonClose onClick={handleClose} title="Close panel" />
 * - Different size: <ButtonClose onClick={handleClose} size="sm" />
 */
import { forwardRef } from 'react';
import { mdiClose } from '@mdi/js';
import { Button, type ButtonProps, type ButtonSize } from './Button';
import './ButtonClose.css';

export interface ButtonCloseProps extends Omit<ButtonProps, 'icon' | 'iconOnly' | 'children'> {
  /** Size of the close button */
  size?: ButtonSize;
  /** Accessible title for the button */
  title?: string;
}

export const ButtonClose = forwardRef<HTMLButtonElement, ButtonCloseProps>(function ButtonClose(
  {
    size = 'sm',
    variant = 'ghost',
    title = 'Close',
    className = '',
    ...props
  },
  ref
) {
  const classNames = ['btn-close', className].filter(Boolean).join(' ');

  return (
    <Button
      ref={ref}
      icon={mdiClose}
      iconOnly
      variant={variant}
      size={size}
      className={classNames}
      title={title}
      aria-label={title}
      {...props}
    />
  );
});

export default ButtonClose;
