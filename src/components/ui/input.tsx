import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** The id of the element carrying this input's error, wired through aria-describedby. */
  errorId?: string;
  error?: string;
}

/**
 * A labelled input. The label is a real <label for>, never a placeholder — a placeholder is a
 * hint, it disappears on focus, and it is not an accessible name.
 *
 * Never below 16px: a smaller input makes a phone zoom on focus.
 */
export function Input({ label, error, errorId, id, className = '', ...rest }: InputProps) {
  const generated = useId();
  const inputId = id ?? `input-${generated}`;
  const describedBy = [rest['aria-describedby'], error ? (errorId ?? `${inputId}-error`) : undefined]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex flex-col gap-space-1">
      <label htmlFor={inputId} className="text-sm text-text">
        {label}
      </label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`min-h-[44px] rounded-radius border bg-bg px-space-3 text-base text-text placeholder:text-text-muted ${
          error ? 'border-negative' : 'border-border'
        } ${className}`}
      />
      {error ? (
        <p id={errorId ?? `${inputId}-error`} role="alert" className="text-sm text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}