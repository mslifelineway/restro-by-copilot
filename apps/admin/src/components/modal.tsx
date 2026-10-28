'use client';
import { useEffect, useRef } from 'react';

/** Native <dialog> modal (focus trap, Esc to close, backdrop). Children are only mounted while open, so forms reset. */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="m-auto w-full max-w-lg rounded-lg border bg-card p-0 text-foreground backdrop:bg-black/40">
      {open && (
        <div className="space-y-4 p-5">
          <h2 className="font-semibold">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
