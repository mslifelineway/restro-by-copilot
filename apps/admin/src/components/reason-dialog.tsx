'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** Native <dialog> prompting for the mandatory audit reason (and optional expiry) on flag changes. */
export function ReasonDialog({
  open, title, withExpiry, busy, error, onSubmit, onClose,
}: {
  open: boolean; title: string; withExpiry?: boolean; busy?: boolean; error?: string | null;
  onSubmit: (v: { reason: string; expiresAt?: string }) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { setReason(''); setExpiresAt(''); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} onClose={onClose} className="m-auto w-full max-w-md rounded-lg border bg-card p-0 text-foreground backdrop:bg-black/40">
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ reason: reason.trim(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined });
        }}
      >
        <h2 className="font-semibold">{title}</h2>
        <div className="space-y-1">
          <label htmlFor="reason" className="text-sm">Reason (recorded in the audit log)</label>
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} required autoFocus />
        </div>
        {withExpiry && (
          <div className="space-y-1">
            <label htmlFor="expires" className="text-sm">Expires (optional)</label>
            <Input id="expires" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || reason.trim().length < 3}>{busy ? 'Saving…' : 'Confirm'}</Button>
        </div>
      </form>
    </dialog>
  );
}
