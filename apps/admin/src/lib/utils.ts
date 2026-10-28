import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...i: ClassValue[]) => twMerge(clsx(i));
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export const statusTone = (s: string) => (s === 'active' ? 'success' : s === 'trial' ? 'warning' : s === 'suspended' ? 'danger' : 'neutral') as 'success' | 'warning' | 'danger' | 'neutral';

/** Groups rows by module, preserving first-seen order. */
export function groupByModule<T extends { module: string }>(rows: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.module, [...(m.get(r.module) ?? []), r]);
  return [...m.entries()];
}
