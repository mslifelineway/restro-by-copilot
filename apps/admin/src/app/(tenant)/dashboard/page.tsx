'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { api } from '@/lib/api';
import type { Subscription, TenantProfile } from '@/lib/types';
import { useCan, useMe } from '@/lib/use-me';
import { fmtDate, statusTone } from '@/lib/utils';

export default function DashboardPage() {
  const me = useMe().data;
  const canTenant = useCan('tenant:read');
  const canSub = useCan('subscription:read');
  const tenant = useQuery({ queryKey: ['tenant-profile'], queryFn: () => api.get<TenantProfile>('/v1/tenant'), enabled: canTenant });
  const sub = useQuery({ queryKey: ['subscription'], queryFn: () => api.get<Subscription>('/v1/subscription'), enabled: canSub });

  return (
    <>
      <PageHeader title={tenant.data?.name ?? 'Overview'} description={tenant.data ? `Restaurant ID: ${tenant.data.slug}` : 'Welcome back.'} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader>Status</CardHeader><CardBody className="space-y-2 text-sm">
          {tenant.data ? <Badge tone={statusTone(tenant.data.status)}>{tenant.data.status}</Badge> : <span className="text-muted-foreground">—</span>}
          {sub.data && <p className="text-muted-foreground">Plan: {sub.data.plan_name}{sub.data.trial_ends_at ? ` · trial ends ${fmtDate(sub.data.trial_ends_at)}` : ''}</p>}
        </CardBody></Card>
        <Card><CardHeader>Usage</CardHeader><CardBody className="space-y-1 text-sm">
          {sub.data ? (<>
            <p>Outlets: {sub.data.outlets_used} / {sub.data.limits.outlets}</p>
            <p>Users: {sub.data.users_used} / {sub.data.limits.users}</p>
          </>) : <span className="text-muted-foreground">Not available for your role</span>}
        </CardBody></Card>
        <Card><CardHeader>Modules enabled</CardHeader><CardBody className="text-sm">
          {me?.kind === 'tenant' ? <p>{me.features.length} feature module(s) on your plan</p> : null}
        </CardBody></Card>
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        Start with <Link className="text-primary hover:underline" href="/outlets">outlets</Link>, then add your{' '}
        <Link className="text-primary hover:underline" href="/users">team</Link> and register your{' '}
        <Link className="text-primary hover:underline" href="/devices">POS devices</Link>.
      </p>
    </>
  );
}
