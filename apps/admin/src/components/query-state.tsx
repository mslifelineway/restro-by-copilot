import { ApiError } from '@/lib/api';

export const Loading = () => <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

export function ErrorBox({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : null;
  return (
    <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
      {e?.message ?? 'Something went wrong'}
      {e && <span className="ml-2 text-xs opacity-70">{e.code}{e.requestId ? ` · ${e.requestId}` : ''}</span>}
    </div>
  );
}
