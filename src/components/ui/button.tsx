import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Rendered in place of the children while the button is disabled. The busy state every
   * screen uses: "Signing in…", "Creating account…".
   */
  busyLabel?: string;
}

/**
 * Presentational on purpose. It holds no state and is not a Client Component, because the
 * busy state a caller wants comes from the action it is calling — conventions.md puts 'use
 * client' only where there is genuine interaction, and a button is not one.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  busyLabel,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-primary text-primary-contrast hover:opacity-90',
    secondary: 'bg-surface text-text border border-border hover:bg-bg',
    destructive: 'bg-negative text-primary-contrast hover:opacity-90',
  };
  // 44px is the minimum touch target that governs phone layout.
  const sizes: Record<ButtonSize, string> = {
    sm: 'min-h-[44px] px-space-3 text-sm',
    md: 'min-h-[44px] px-space-4 text-base',
    lg: 'min-h-[44px] w-full px-space-4 text-base sm:w-auto',
  };

  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-space-2 rounded-radius font-medium transition-colors duration-150 disabled:opacity-60 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {disabled && busyLabel ? busyLabel : children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = 'primary',
  size = 'md',
  className = '',
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
}) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-primary text-primary-contrast hover:opacity-90',
    secondary: 'bg-surface text-text border border-border hover:bg-bg',
    destructive: 'bg-negative text-primary-contrast hover:opacity-90',
  };
  const sizes: Record<ButtonSize, string> = {
    sm: 'min-h-[44px] px-space-3 text-sm',
    md: 'min-h-[44px] px-space-4 text-base',
    lg: 'min-h-[44px] w-full px-space-4 text-base sm:w-auto',
  };

  return (
    <a
      href={href}
      className={`inline-flex items-center justify-center gap-space-2 rounded-radius font-medium transition-colors duration-150 ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </a>
  );
}