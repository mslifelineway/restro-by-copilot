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
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { api, ApiError, applyServerErrors } from '@/lib/api';
import type { Outlet } from '@/lib/types';
import { useCan } from '@/lib/use-me';

const createSchema = z.object({
  name: z.string().min(2).max(100),
  code: z.string().regex(/^[A-Z0-9_-]{2,20}$/, 'Uppercase letters, digits, - or _ (2-20 chars)'),
  gstin: z.string().optional(),
  timezone: z.string().optional(),
});
type Form = z.infer<typeof createSchema>;

function OutletForm({ outlet, onDone }: { outlet?: Outlet; onDone: () => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(createSchema),
    defaultValues: outlet ? { name: outlet.name, code: outlet.code, gstin: outlet.gstin ?? '', timezone: outlet.timezone ?? '' } : {},
  });
  const save = useMutation({
    mutationFn: (v: Form) => {
      const body = { ...v, gstin: v.gstin || undefined, timezone: v.timezone || undefined };
      if (!outlet) return api.post('/v1/outlets', body);
      const { code: _code, ...patch } = body; // code is immutable
      return api.patch(`/v1/outlets/${outlet.id}`, patch);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['outlets'] }); qc.invalidateQueries({ queryKey: ['subscription'] }); onDone(); },
    onError: (e) => setErr(applyServerErrors(e, setError)),
  });
  return (
    <form onSubmit={handleSubmit((v) => { setErr(null); save.mutate(v); })} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label="Outlet name" error={errors.name?.message}><Input {...register('name')} /></Field>
      <Field label="Code" error={errors.code?.message} hint={outlet ? 'Cannot be changed' : 'Short unique code, e.g. MAIN'}><Input disabled={!!outlet} {...register('code')} /></Field>
      <Field label="GSTIN (optional)" error={errors.gstin?.message}><Input {...register('gstin')} /></Field>
      <Field label="Time zone (optional)" error={errors.timezone?.message}><Input placeholder="Defaults to business time zone" {...register('timezone')} /></Field>
      <div className="sm:col-span-2 flex items-center justify-end gap-2">
        {err && <p role="alert" className="mr-auto text-sm text-destructive">{err}</p>}
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

export default function OutletsPage() {
  const qc = useQueryClient();
  const canManage = useCan('outlet:manage');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Outlet | 'new' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['outlets', page], queryFn: () => api.list<Outlet>(`/v1/outlets?page=${page}&limit=20`) });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/outlets/${id}`),
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['outlets'] }); qc.invalidateQueries({ queryKey: ['subscription'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  return (
    <>
      <PageHeader title="Outlets" description="Physical locations. Each plan allows a limited number of outlets." actions={canManage && <Button onClick={() => setEditing('new')}>New outlet</Button>} />
      {err && <p role="alert" className="mb-3 text-sm text-destructive">{err}</p>}
      <Card>
        {q.isLoading && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (<>
          <Table>
            <thead><tr><Th>Name</Th><Th>Code</Th><Th>GSTIN</Th><Th>Time zone</Th>{canManage && <Th className="text-right">Actions</Th>}</tr></thead>
            <tbody>
              {q.data.items.map((o) => (
                <tr key={o.id}>
                  <Td className="font-medium">{o.name}</Td>
                  <Td className="font-mono text-xs">{o.code}</Td>
                  <Td>{o.gstin ?? '—'}</Td>
                  <Td>{o.timezone ?? 'Business default'}</Td>
                  {canManage && <Td className="space-x-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditing(o)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete outlet "${o.name}"?`)) del.mutate(o.id); }}>Delete</Button>
                  </Td>}
                </tr>
              ))}
            </tbody>
          </Table>
          <PaginationBar p={q.data.pagination} onPage={setPage} />
        </>)}
      </Card>
      <Modal open={!!editing} title={editing === 'new' ? 'New outlet' : 'Edit outlet'} onClose={() => setEditing(null)}>
        <OutletForm outlet={editing && editing !== 'new' ? editing : undefined} onDone={() => setEditing(null)} />
      </Modal>
    </>
  );
}
