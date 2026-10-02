'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from './button';

/**
 * A confirmation dialog. 'use client' is applied deliberately, for the focus trap — not by
 * omission.
 *
 * Called by piece 2's Leave and Remove controls (src/components/member-actions.tsx), the first
 * destructive confirmations in the product. Archiving does not confirm: docs/ui.md exempts it
 * because it is reversible and owner-only.
 */
export interface DialogProps {
  open: boolean;
  title: string;
  /** What is being destroyed and what it costs, in one sentence. */
  consequence: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Dialog({ open, title, consequence, confirmLabel, onConfirm, onCancel }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;

    // Escape cancels, and focus moves into the dialog so it cannot escape to the page behind.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;

      // Focus trap: the only stops are the ones inside the panel.
      const stops = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea')];
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Focus returns to the control that opened it.
      previouslyFocused?.focus();
      setConfirming(false);
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-text/40 p-space-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-[360px] rounded-radius border border-border bg-bg p-space-4"
      >
        <h2 className="text-xl">{title}</h2>
        <p className="mt-space-2 text-base text-text-muted">{consequence}</p>
        <div className="mt-space-4 flex justify-end gap-space-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={confirming}
            busyLabel="Working…"
            onClick={() => {
              setConfirming(true);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}