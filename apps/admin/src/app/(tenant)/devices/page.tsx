'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Modal } from '@/components/modal';
import { PageHeader } from '@/components/page-header';
import { PaginationBar } from '@/components/pagination-bar';
import { ErrorBox, Loading } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { api, ApiError, applyServerErrors } from '@/lib/api';
import type { DeviceRow, Outlet } from '@/lib/types';
import { useCan } from '@/lib/use-me';
import { fmtDate } from '@/lib/utils';

const schema = z.object({ name: z.string().min(2).max(100), platform: z.enum(['android', 'ios', 'windows', 'web']), outletId: z.string().optional() });
type Form = z.infer<typeof schema>;

function RegisterForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const outlets = useQuery({ queryKey: ['outlets', 'all'], queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100') });
  const { register, handleSubmit, setError, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { platform: 'android' } });
  const create = useMutation({
    mutationFn: (v: Form) => api.post<{ id: string }>('/v1/devices', { ...v, outletId: v.outletId || undefined }),
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ['devices'] }); setCreated(d.id); },
    onError: (e) => setErr(applyServerErrors(e, setError)),
  });
  const [created, setCreated] = useState<string | null>(null);

  if (created) {
    return (
      <div className="space-y-3">
        <p className="text-sm">Device registered. Enter this Device ID in the POS app when signing in:</p>
        <code className="block break-all rounded-md bg-muted p-2 text-sm" data-testid="device-id">{created}</code>
        <div className="flex justify-end"><Button onClick={onDone}>Done</Button></div>
      </div>
    );
  }
  return (
    <form onSubmit={handleSubmit((v) => { setErr(null); create.mutate(v); })} className="grid gap-3 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2"><Field label="Device name" error={errors.name?.message} hint="e.g. Counter 1 tablet"><Input {...register('name')} /></Field></div>
      <Field label="Platform" error={errors.platform?.message}><Select className="w-full" {...register('platform')}>{['android', 'ios', 'windows', 'web'].map((p) => <option key={p}>{p}</option>)}</Select></Field>
      <Field label="Outlet"><Select className="w-full" {...register('outletId')}><option value="">Not tied to an outlet</option>{outlets.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <div className="sm:col-span-2 flex items-center justify-end gap-2">
        {err && <p role="alert" className="mr-auto text-sm text-destructive">{err}</p>}
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Registering…' : 'Register'}</Button>
      </div>
    </form>
  );
}

export default function DevicesPage() {
  const qc = useQueryClient();
  const canManage = useCan('device:manage');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['devices', page], queryFn: () => api.list<DeviceRow>(`/v1/devices?page=${page}&limit=20`) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/v1/devices/${id}/revoke`, {}),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['devices'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  return (
    <>
      <PageHeader title="Devices" description="POS, waiter and kitchen tablets allowed to sign in. Revoking a device signs it out immediately." actions={canManage && <Button onClick={() => setOpen(true)}>Register device</Button>} />
      {err && <p role="alert" className="mb-3 text-sm text-destructive">{err}</p>}
      <Card>
        {q.isLoading && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (<>
          <Table>
            <thead><tr><Th>Name</Th><Th>Platform</Th><Th>Status</Th><Th>Last seen</Th>{canManage && <Th className="text-right">Actions</Th>}</tr></thead>
            <tbody>
              {q.data.items.map((d) => (
                <tr key={d.id}>
                  <Td><div className="font-medium">{d.name}</div><div className="font-mono text-xs text-muted-foreground">{d.id}</div></Td>
                  <Td>{d.platform}</Td>
                  <Td><Badge tone={d.status === 'active' ? 'success' : 'danger'}>{d.status}</Badge></Td>
                  <Td className="text-muted-foreground">{fmtDate(d.lastSeenAt)}</Td>
                  {canManage && <Td className="text-right">{d.status === 'active' && <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Revoke ${d.name}? It will be signed out now.`)) revoke.mutate(d.id); }}>Revoke</Button>}</Td>}
                </tr>
              ))}
              {!q.data.items.length && <tr><Td colSpan={5} className="text-center text-muted-foreground">No devices registered yet</Td></tr>}
            </tbody>
          </Table>
          <PaginationBar p={q.data.pagination} onPage={setPage} />
        </>)}
      </Card>
      <Modal open={open} title="Register device" onClose={() => setOpen(false)}><RegisterForm onDone={() => setOpen(false)} /></Modal>
    </>
  );
}
