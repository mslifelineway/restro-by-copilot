'use client';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { ErrorBox, Loading } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import type { Subscription } from '@/lib/types';
import { fmtDate } from '@/lib/utils';

function Meter({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm"><span>{label}</span><span className="text-muted-foreground">{used} / {max}</span></div>
      <div role="progressbar" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={max} className="h-2 rounded-full bg-muted">
        <div className={pct >= 90 ? 'h-2 rounded-full bg-destructive' : 'h-2 rounded-full bg-primary'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function SubscriptionPage() {
  const q = useQuery({ queryKey: ['subscription'], queryFn: () => api.get<Subscription>('/v1/subscription') });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;
  const s = q.data;
  return (
    <>
      <PageHeader title="Subscription" description="Your plan, billing status and limits. To change plan, contact support." />
      {!s ? <p className="text-sm text-muted-foreground">No active subscription.</p> : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card><CardHeader>Plan</CardHeader><CardBody className="space-y-2 text-sm">
            <p className="text-lg font-semibold">{s.plan_name}</p>
            <p>Status: <Badge tone={s.status === 'active' ? 'success' : s.status === 'trialing' ? 'warning' : 'danger'}>{s.status}</Badge></p>
            <p className="text-muted-foreground">Billing: {s.billing_interval}</p>
            {s.trial_ends_at && <p className="text-muted-foreground">Trial ends {fmtDate(s.trial_ends_at)}</p>}
            {s.current_period_end && !s.trial_ends_at && <p className="text-muted-foreground">Renews {fmtDate(s.current_period_end)}</p>}
          </CardBody></Card>
          <Card><CardHeader>Usage</CardHeader><CardBody className="space-y-4">
            <Meter label="Outlets" used={s.outlets_used} max={s.limits.outlets} />
            <Meter label="Users" used={s.users_used} max={s.limits.users} />
          </CardBody></Card>
        </div>
      )}
    </>
  );
}
