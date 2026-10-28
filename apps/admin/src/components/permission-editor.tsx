'use client';
import { PERMISSIONS } from '@rms/shared';
import { Input } from './ui/input';

export type PermState = Record<string, Record<string, number | string | boolean>>;

/** Fields shown for permissions that carry limits. Money is entered in rupees and stored in paise. */
const LIMIT_FIELDS: Record<string, { key: string; label: string; paise?: boolean }> = {
  'discount:apply': { key: 'maxPercent', label: 'Max discount %' },
  'refund:create': { key: 'maxAmountPaise', label: 'Max refund (₹)', paise: true },
};

const groups = (() => {
  const m = new Map<string, string[]>();
  for (const p of PERMISSIONS) m.set(p.split(':')[0], [...(m.get(p.split(':')[0]) ?? []), p]);
  return [...m.entries()];
})();

/** Checklist of the fixed permission catalog, grouped by resource, with optional limits. */
export function PermissionEditor({ value, onChange, readOnly }: { value: PermState; onChange?: (v: PermState) => void; readOnly?: boolean }) {
  const toggle = (p: string, on: boolean) => {
    const next = { ...value };
    if (on) next[p] = {}; else delete next[p];
    onChange?.(next);
  };
  const setLimit = (p: string, key: string, raw: string, paise?: boolean) => {
    const next = { ...value };
    if (raw === '') next[p] = {};
    else next[p] = { [key]: paise ? Math.round(Number(raw) * 100) : Number(raw) };
    onChange?.(next);
  };

  return (
    <div className="space-y-4">
      {groups.map(([group, perms]) => (
        <fieldset key={group} className="rounded-md border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {perms.map((p) => {
              const on = p in value;
              const lf = LIMIT_FIELDS[p];
              const cur = lf ? value[p]?.[lf.key] : undefined;
              return (
                <div key={p} className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={on} disabled={readOnly} onChange={(e) => toggle(p, e.target.checked)} />
                    <span className="font-mono text-xs">{p}</span>
                  </label>
                  {on && lf && (
                    <div className="ml-6">
                      <Input
                        type="number" min={0} step="any" disabled={readOnly} aria-label={`${p} ${lf.label}`}
                        placeholder={`${lf.label} (blank = no limit)`}
                        value={cur === undefined ? '' : lf.paise ? Number(cur) / 100 : Number(cur)}
                        onChange={(e) => setLimit(p, lf.key, e.target.value, lf.paise)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
