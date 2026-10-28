'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { ErrorBox, Loading } from '@/components/query-state';
import { ReasonDialog } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import type { Entitlement, TenantDetail } from '@/lib/types';
import { useCanWrite } from '@/lib/use-me';
import { fmtDate, groupByModule, statusTone } from '@/lib/utils';

const sourceLabel: Record<Entitlement['source'], string> = {
  kill_switch: 'Global kill switch', outlet_override: 'Outlet override', tenant_override: 'Tenant override',
  plan: 'Plan default', dependency: 'Dependency off', none: 'Not in plan',
};

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [plan, setPlan] = useState('');
  const [draft, setDraft] = useState<{ key: string; enabled: boolean } | null>(null);
  const [mutError, setMutError] = useState<string | null>(null);

  const tenant = useQuery({ queryKey: ['tenant', id], queryFn: () => api.get<TenantDetail>(`/v1/platform/tenants/${id}`) });
  const features = useQuery({ queryKey: ['tenant-features', id], queryFn: () => api.get<Entitlement[]>(`/v1/platform/tenants/${id}/features`) });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['tenant', id] }); qc.invalidateQueries({ queryKey: ['tenant-features', id] }); qc.invalidateQueries({ queryKey: ['tenants'] }); };
  const onError = (e: unknown) => setMutError(e instanceof ApiError ? e.message : 'Something went wrong');

  const setStatus = useMutation({ mutationFn: (status: string) => api.patch(`/v1/platform/tenants/${id}/status`, { status }), onSuccess: refresh, onError });
  const changePlan = useMutation({ mutationFn: (planCode: string) => api.patch(`/v1/platform/tenants/${id}/plan`, { planCode }), onSuccess: refresh, onError });
  const override = useMutation({
    mutationFn: (v: { key: string; enabled: boolean; reason: string; expiresAt?: string }) =>
      api.put(`/v1/platform/tenants/${id}/features/${v.key}`, { enabled: v.enabled, reason: v.reason, expiresAt: v.expiresAt }),
    onSuccess: () => { setDraft(null); refresh(); },
  });
  const clear = useMutation({ mutationFn: (key: string) => api.delete(`/v1/platform/tenants/${id}/features/${key}`), onSuccess: refresh, onError });

  if (tenant.isLoading) return <Loading />;
  if (tenant.isError) return <ErrorBox error={tenant.error} />;
  const t = tenant.data!;
  const byModule = groupByModule(features.data ?? []);

  return (
    <>
      <PageHeader
        title={t.name}
        description={`Slug: ${t.slug} · ${t.timezone} · ${t.currency}`}
        actions={canWrite && t.status !== 'deleted' && (
          t.status === 'suspended'
            ? <Button onClick={() => setStatus.mutate('active')}>Reactivate</Button>
            : <Button variant="destructive" onClick={() => { if (confirm(`Suspend ${t.name}? All their users are blocked immediately.`)) setStatus.mutate('suspended'); }}>Suspend</Button>
        )}
      />
      {mutError && <div className="mb-4"><p role="alert" className="text-sm text-destructive">{mutError}</p></div>}

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card><CardHeader>Status</CardHeader><CardBody className="space-y-2">
          <Badge tone={statusTone(t.status)}>{t.status}</Badge>
          <p className="text-sm text-muted-foreground">Subscription: {t.subscription?.status ?? '—'}</p>
          {t.subscription?.trial_ends_at && <p className="text-sm text-muted-foreground">Trial ends {fmtDate(t.subscription.trial_ends_at)}</p>}
        </CardBody></Card>
        <Card><CardHeader>Usage</CardHeader><CardBody className="text-sm">
          <p>{t.usage.outlets} outlet(s)</p><p>{t.usage.users} user(s)</p>
        </CardBody></Card>
        <Card><CardHeader>Plan</CardHeader><CardBody className="space-y-2">
          <Badge>{t.plan}</Badge>
          {canWrite && (
            <div className="flex gap-2">
              <Select aria-label="New plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
                <option value="">Change to…</option>
                {['trial', 'starter', 'growth', 'enterprise'].filter((p) => p !== t.plan).map((p) => <option key={p}>{p}</option>)}
              </Select>
              <Button size="sm" variant="outline" disabled={!plan || changePlan.isPending} onClick={() => { changePlan.mutate(plan); setPlan(''); }}>Apply</Button>
            </div>
          )}
        </CardBody></Card>
      </div>

      <Card>
        <CardHeader>Effective features <span className="text-xs font-normal text-muted-foreground">what this tenant actually sees</span></CardHeader>
        {features.isLoading && <Loading />}
        {features.isError && <div className="p-4"><ErrorBox error={features.error} /></div>}
        {features.data && (
          <Table>
            <thead><tr><Th>Feature</Th><Th>State</Th><Th>Source</Th>{canWrite && <Th className="text-right">Override</Th>}</tr></thead>
            <tbody>
              {byModule.map(([module, rows]) => (
                <FragmentRows key={module} module={module} cols={canWrite ? 4 : 3}>
                  {rows.map((f) => (
                    <tr key={f.key}>
                      <Td className="font-mono text-xs">{f.key}</Td>
                      <Td><Badge tone={f.enabled ? 'success' : 'neutral'}>{f.enabled ? 'On' : 'Off'}</Badge></Td>
                      <Td className="text-muted-foreground">{sourceLabel[f.source]}</Td>
                      {canWrite && (
                        <Td className="space-x-2 text-right">
                          <Button size="sm" variant="outline" onClick={() => setDraft({ key: f.key, enabled: !f.enabled })}>{f.enabled ? 'Disable' : 'Enable'}</Button>
                          {f.source === 'tenant_override' && <Button size="sm" variant="ghost" onClick={() => clear.mutate(f.key)}>Clear</Button>}
                        </Td>
                      )}
                    </tr>
                  ))}
                </FragmentRows>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ReasonDialog
        open={!!draft}
        title={draft ? `${draft.enabled ? 'Enable' : 'Disable'} ${draft.key} for ${t.name}` : ''}
        withExpiry
        busy={override.isPending}
        error={override.error instanceof ApiError ? override.error.message : null}
        onClose={() => { setDraft(null); override.reset(); }}
        onSubmit={(v) => draft && override.mutate({ key: draft.key, enabled: draft.enabled, ...v })}
      />
    </>
  );
}

function FragmentRows({ module, cols, children }: { module: string; cols: number; children: React.ReactNode }) {
  return (
    <>
      <tr><td colSpan={cols} className="bg-muted px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{module}</td></tr>
      {children}
    </>
  );
}
