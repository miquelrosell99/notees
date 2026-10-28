/**
 * TextField Component
 *
 * A reusable text input component with consistent styling.
 * Features a minimal underline that highlights when active — the 2px
 * accent underline AND the accent label (the wrapper is the focus scope).
 *
 * Thin fleet wrapper over the normalized catalog input + label
 * (src/components/ui/input.tsx, label.tsx): the underline register is the
 * app's field identity (the catalog Input is a boxed field), so the wrapper
 * composes the catalog base and re-points the shell classes at the
 * underline register. All visual values resolve to tokens through the
 * Tailwind config (registered-mapping mode of the drift gate).
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "./cn.js";

export type TextFieldSize = "sm" | "md" | "lg";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Size variant */
  size?: TextFieldSize;
  /** Error state */
  error?: boolean;
  /** Error message */
  errorMessage?: string;
  /** Label text */
  label?: string;
  /** Additional wrapper className */
  wrapperClassName?: string;
  /** Optional icon to show on the right with a divider */
  icon?: ReactNode;
  /** Additional className for the container */
  containerClassName?: string;
}

const SIZE_CLASSES: Record<TextFieldSize, string> = {
  sm: "h-md py-1 text-xs",
  md: "h-xl py-2 text-sm",
  lg: "h-xl py-3 text-base",
};

/**
 * TextField component for text input with consistent styling.
 * Provides a minimal underline that highlights when active.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    size = "md",
    error = false,
    errorMessage,
    label,
    wrapperClassName = "",
    className = "",
    disabled,
    icon,
    containerClassName = "",
    "aria-describedby": ariaDescribedBy,
    id: idProp,
    ...props
  },
  ref,
) {
  const errorId = useId();
  const generatedId = useId();
  const id = idProp ?? generatedId;

  const describedByIds =
    [error && errorMessage ? errorId : undefined, ariaDescribedBy].filter(Boolean).join(" ") ||
    undefined;

  const underlineClasses = error
    ? "border-b-error focus:border-b-error focus:shadow-field-error focus-visible:shadow-none"
    : "border-b-outline-variant focus:border-b-primary focus:shadow-field-focus focus-visible:shadow-none";

  const inputClasses = cn(
    // rounded-none: the global input register's extra-large radius would
    // curve the bottom border's ends.
    "w-full bg-transparent border-b rounded-none px-0 text-on-surface transition-colors duration-short ease-standard",
    "placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed",
    SIZE_CLASSES[size],
    underlineClasses,
    icon && "border-b-0 focus:shadow-none",
    className,
  );

  // The wrapper is the `group` scope so the label rides the focus state:
  // the classic underline register accents the label when the field is
  // active (Material's focused-label idiom), and the error label takes the
  // error token at rest as well as on focus.
  const wrapperClasses = cn("flex flex-col gap-1 group", wrapperClassName);

  const labelClasses = cn(
    "text-sm font-semibold transition-colors duration-short ease-standard",
    error ? "text-error" : "text-on-surface-variant group-focus-within:text-primary",
  );

  const containerClasses = cn(
    "flex items-center w-full bg-transparent border-b rounded-none transition-colors duration-short ease-standard",
    underlineClasses,
    "focus-within:outline-none focus-within:focus-visible:outline-none",
    error ? "focus-within:border-b-error focus-within:shadow-field-error" : "focus-within:border-b-primary focus-within:shadow-field-focus",
    disabled && "opacity-50 cursor-not-allowed",
    containerClassName,
  );

  const errorElement = error && errorMessage ? (
    <span id={errorId} className="text-xs text-error" role="alert">
      {errorMessage}
    </span>
  ) : null;

  const inputElement = icon ? (
    <div className={containerClasses}>
      <input
        ref={ref}
        id={id}
        className={inputClasses}
        disabled={disabled}
        aria-invalid={error || undefined}
        aria-describedby={describedByIds}
        {...props}
      />
      <div className="w-px h-xs bg-outline-variant mx-2" />
      <div className="flex items-center justify-center pr-3 text-outline">{icon}</div>
    </div>
  ) : (
    <input
      ref={ref}
      id={id}
      className={inputClasses}
      disabled={disabled}
      aria-invalid={error || undefined}
      aria-describedby={describedByIds}
      {...props}
    />
  );

  if (label) {
    return (
      <div className={wrapperClasses}>
        <label htmlFor={id} className={labelClasses}>
          {label}
        </label>
        {inputElement}
        {errorElement}
      </div>
    );
  }

  return (
    <>
      {inputElement}
      {errorElement}
    </>
  );
});
