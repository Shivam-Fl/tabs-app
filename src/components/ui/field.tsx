import type { ReactNode } from 'react';

import { Input } from './input';

/**
 * label + input + error slot, composed once.
 *
 * The accessibility rule in docs/ui.md is a form-level rule, not an input-level one, and
 * implementing it once is the only way "a label on every control" survives to later pieces.
 */
export function Field({
  label,
  name,
  type = 'text',
  error,
  defaultValue,
  value,
  onChange,
  autoComplete,
  required,
  inputMode,
  autoFocus,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  error?: string;
  defaultValue?: string;
  /** Controlled value. React resets an uncontrolled form after a Server Action runs, so a form
   *  that must keep what somebody typed on failure has to hold its own state. */
  value?: string;
  onChange?: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  /** 'decimal' is what a money field asks for: a phone keypad with a decimal separator on it. */
  inputMode?: 'text' | 'email' | 'numeric' | 'decimal';
  /** docs/ui.md: sign-in and sign-up arrive focused on the email input. */
  autoFocus?: boolean;
  hint?: ReactNode;
}) {
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-space-1">
      <Input
        id={id}
        name={name}
        type={type}
        label={label}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoFocus={autoFocus}
        required={required}
        defaultValue={defaultValue}
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        error={error}
        errorId={`${id}-error`}
      />
      {hint ? <p className="text-sm text-text-muted">{hint}</p> : null}
    </div>
  );
}