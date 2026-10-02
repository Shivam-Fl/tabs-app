import type { HTMLAttributes, ReactNode } from 'react';

/**
 * A raised surface. Below 480px it loses its border, so on a phone it does not read as a
 * dialog — the rule lives in globals.css, once, rather than in every call site's classes.
 */
export function Card({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div {...rest} className={`card rounded-radius border border-border bg-surface p-space-4 sm:p-space-4 ${className}`}>
      {children}
    </div>
  );
}