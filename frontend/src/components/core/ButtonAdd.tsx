/**
 * ButtonAdd Component
 * 
 * A specialized add button component based on the Button component.
 * Used for adding new items, creating content, and other additive actions.
 * 
 * Usage:
 * - Basic: <ButtonAdd onClick={handleAdd} />
 * - With title: <ButtonAdd onClick={handleAdd} title="Add property" />
 * - Different size: <ButtonAdd onClick={handleAdd} size="sm" />
 * - With label: <ButtonAdd onClick={handleAdd}>Add item</ButtonAdd>
 */
import { forwardRef, type ReactNode } from 'react';
import { mdiPlus } from '@mdi/js';
import { Button, type ButtonProps, type ButtonSize } from './Button';
import './ButtonAdd.css';

export interface ButtonAddProps extends Omit<ButtonProps, 'icon'> {
  /** Size of the add button */
  size?: ButtonSize;
  /** Accessible title for the button */
  title?: string;
  /** Optional label text to show next to the icon */
  children?: ReactNode;
}

export const ButtonAdd = forwardRef<HTMLButtonElement, ButtonAddProps>(function ButtonAdd(
  {
    size = 'sm',
    variant = 'ghost',
    title = 'Add',
    className = '',
    children,
    iconOnly,
    ...props
  },
  ref
) {
  const classNames = ['btn-add', className].filter(Boolean).join(' ');
  const isIconOnly = iconOnly ?? !children;

  return (
    <Button
      ref={ref}
      icon={mdiPlus}
      iconOnly={isIconOnly}
      variant={variant}
      size={size}
      className={classNames}
      title={title}
      aria-label={title}
      {...props}
    >
      {children}
    </Button>
  );
});
