'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { ErrorBox, Loading } from '@/components/query-state';
import { ReasonDialog } from '@/components/reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import type { Feature, Plan } from '@/lib/types';
import { useCanWrite } from '@/lib/use-me';
import { groupByModule } from '@/lib/utils';

export default function FeaturesPage() {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const [kill, setKill] = useState<Feature | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const features = useQuery({ queryKey: ['features'], queryFn: () => api.get<Feature[]>('/v1/platform/features') });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/v1/platform/plans') });

  const togglePlan = useMutation({
    mutationFn: (v: { plan: string; key: string; enabled: boolean }) => api.put(`/v1/platform/plans/${v.plan}/features/${v.key}`, { enabled: v.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plans'] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const killSwitch = useMutation({
    mutationFn: (v: { key: string; on: boolean; reason: string }) => api.put(`/v1/platform/features/${v.key}/kill-switch`, { on: v.on, reason: v.reason }),
    onSuccess: () => { setKill(null); qc.invalidateQueries({ queryKey: ['features'] }); },
  });

  if (features.isLoading || plans.isLoading) return <Loading />;
  if (features.isError || plans.isError) return <ErrorBox error={features.error ?? plans.error} />;
  const ps = plans.data!;
  const grouped = groupByModule(features.data!);

  return (
    <>
      <PageHeader title="Features & plans" description="Plan matrix (default entitlements per plan) and the global kill switch. Kill switches override every tenant." />
      {err && <p role="alert" className="mb-3 text-sm text-destructive">{err}</p>}
      <Card>
        <Table>
          <thead>
            <tr><Th>Feature</Th>{ps.map((p) => <Th key={p.code} className="text-center">{p.name}</Th>)}<Th className="text-center">Kill switch</Th></tr>
          </thead>
          <tbody>
            {grouped.map(([module, rows]) => (
              <ModuleRows key={module} module={module} cols={ps.length + 2}>
                {rows.map((f) => (
                  <tr key={f.key}>
                    <Td>
                      <div className="font-mono text-xs">{f.key}</div>
                      <div className="text-xs text-muted-foreground">{f.description}{f.depends_on.length ? ` · needs ${f.depends_on.join(', ')}` : ''}</div>
                    </Td>
                    {ps.map((p) => (
                      <Td key={p.code} className="text-center">
                        <input
                          type="checkbox"
                          aria-label={`${f.key} in ${p.name}`}
                          checked={p.features.includes(f.key)}
                          disabled={!canWrite || togglePlan.isPending}
                          onChange={(e) => togglePlan.mutate({ plan: p.code, key: f.key, enabled: e.target.checked })}
                        />
                      </Td>
                    ))}
                    <Td className="text-center">
                      {f.kill_switch
                        ? <Button size="sm" variant="destructive" disabled={!canWrite} onClick={() => setKill(f)}>KILLED · restore</Button>
                        : canWrite ? <Button size="sm" variant="ghost" onClick={() => setKill(f)}>Kill</Button> : <Badge>live</Badge>}
                    </Td>
                  </tr>
                ))}
              </ModuleRows>
            ))}
          </tbody>
        </Table>
      </Card>

      <ReasonDialog
        open={!!kill}
        title={kill ? `${kill.kill_switch ? 'Restore' : 'Kill'} ${kill.key} for ALL tenants` : ''}
        busy={killSwitch.isPending}
        error={killSwitch.error instanceof ApiError ? killSwitch.error.message : null}
        onClose={() => { setKill(null); killSwitch.reset(); }}
        onSubmit={({ reason }) => kill && killSwitch.mutate({ key: kill.key, on: !kill.kill_switch, reason })}
      />
    </>
  );
}

function ModuleRows({ module, cols, children }: { module: string; cols: number; children: React.ReactNode }) {
  return (
    <>
      <tr><td colSpan={cols} className="bg-muted px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{module}</td></tr>
      {children}
    </>
  );
}
