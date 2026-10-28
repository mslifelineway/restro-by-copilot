'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { ErrorBox, Loading } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import type { Outlet } from '@/lib/types';
import { useCan, useMe } from '@/lib/use-me';

type TableState = 'AVAILABLE' | 'IN_USE' | 'RESERVED' | 'UNAVAILABLE';
type DiningTable = {
  id: string; code: string; name: string; section: string; capacity: number; sortOrder: number;
  state: TableState; mergedOrderId: string | null; activeOrderId: string | null; activeOrderCreatedAt: string | null;
};
const createSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{1,20}$/, 'Use 1–20 uppercase letters, numbers, dash, or underscore'),
  name: z.string().min(1).max(80),
  section: z.string().max(80),
  capacity: z.coerce.number().int().min(1).max(100),
  sortOrder: z.coerce.number().int().min(0).max(100000),
});
type CreateForm = z.infer<typeof createSchema>;
const nextState: Record<TableState, TableState> = {
  AVAILABLE: 'RESERVED',
  IN_USE: 'AVAILABLE',
  RESERVED: 'AVAILABLE',
  UNAVAILABLE: 'AVAILABLE',
};

function CreateTableForm({ onSubmit, pending, error, initial }: {
  onSubmit: (value: CreateForm) => void; pending: boolean; error: string | null; initial?: DiningTable;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: initial
      ? { code: initial.code, name: initial.name, section: initial.section, capacity: initial.capacity, sortOrder: initial.sortOrder }
      : { capacity: 2, section: '', sortOrder: 0 },
  });
  return <form className="grid gap-3 md:grid-cols-3" onSubmit={handleSubmit(onSubmit)} noValidate>
    <Field label="Table code" error={errors.code?.message}><Input autoCapitalize="characters" {...register('code')} /></Field>
    <Field label="Table name" error={errors.name?.message}><Input {...register('name')} /></Field>
    <Field label="Section" error={errors.section?.message}><Input {...register('section')} /></Field>
    <Field label="Capacity" error={errors.capacity?.message}><Input type="number" min={1} max={100} {...register('capacity')} /></Field>
    <Field label="Display order" error={errors.sortOrder?.message}><Input type="number" min={0} {...register('sortOrder')} /></Field>
    <div className="self-end"><Button type="submit" disabled={pending}>{pending ? 'Saving…' : initial ? 'Save changes' : 'Add table'}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive md:col-span-3">{error}</p>}
  </form>;
}

function elapsedOrderTime(createdAt: string, now: number) {
  const elapsedMinutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export default function FloorPage() {
  const qc = useQueryClient();
  const me = useMe();
  const canRead = useCan('table:read');
  const canManage = useCan('table:manage');
  const canCreateOrder = useCan('order:create');
  const canSelectOutlet = useCan('outlet:read');
  const [outletId, setOutletId] = useState('');
  const [filterSection, setFilterSection] = useState('ALL');
  const [editingTable, setEditingTable] = useState<DiningTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const outlets = useQuery({ queryKey: ['outlets', 'all'], queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100'), enabled: canSelectOutlet });
  useEffect(() => {
    if (outletId) return;
    if (me.data?.kind === 'tenant' && me.data.outletId) setOutletId(me.data.outletId);
    else if (outlets.data?.items[0]) setOutletId(outlets.data.items[0].id);
  }, [outletId, me.data, outlets.data]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const headers = { 'x-outlet-id': outletId };
  const tables = useQuery({ queryKey: ['floor-tables', outletId], queryFn: () => api.get<DiningTable[]>('/v1/floor/tables', headers), enabled: !!outletId && canRead });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['floor-tables', outletId] }); };
  const create = useMutation({
    mutationFn: (value: CreateForm) => api.post('/v1/floor/tables', value, headers),
    onSuccess: () => { setError(null); setNotice('Table added.'); refresh(); },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : 'Unable to add table'),
  });
  const setState = useMutation({
    mutationFn: ({ id, state }: { id: string; state: TableState }) => api.put(`/v1/floor/tables/${id}/state`, { state }, headers),
    onSuccess: () => { setError(null); setNotice('Table status updated.'); refresh(); },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : 'Unable to update table status'),
  });
  const update = useMutation({
    mutationFn: ({ id, value }: { id: string; value: CreateForm }) => api.patch(`/v1/floor/tables/${id}`, value, headers),
    onSuccess: () => { setEditingTable(null); setError(null); setNotice('Table details updated.'); refresh(); },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : 'Unable to update table'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/floor/tables/${id}`, headers),
    onSuccess: () => { setError(null); setNotice('Table removed.'); refresh(); },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : 'Unable to remove table'),
  });
  const rows = tables.data ?? [];
  const sections = [...new Set(rows.map((row) => row.section).filter(Boolean))].sort();
  const visible = rows.filter((row) => filterSection === 'ALL' || row.section === filterSection);
  const formError = editingTable
    ? update.error instanceof ApiError ? update.error.message : null
    : create.error instanceof ApiError ? create.error.message : null;
  if (me.isLoading || (canSelectOutlet && outlets.isLoading) || (canRead && !!outletId && tables.isLoading)) return <Loading />;
  if (me.isError) return <ErrorBox error={me.error} />;
  if (outlets.isError) return <ErrorBox error={outlets.error} />;
  if (tables.isError) return <ErrorBox error={tables.error} />;
  return <div>
    <PageHeader title="Floor & tables" description="View table availability by section and manage table status." />
    {notice && <p role="status" className="mb-3 text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {canSelectOutlet && outlets.data && <div className="mb-4 max-w-sm"><Field label="Outlet"><Select value={outletId} onChange={(event) => setOutletId(event.target.value)}><option value="">Choose outlet</option>{outlets.data.items.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field></div>}
    {canManage && <Card className="mb-6 space-y-4 p-4"><h2 className="text-lg font-semibold">{editingTable ? `Edit ${editingTable.name}` : 'Add floor table'}</h2><CreateTableForm key={editingTable?.id ?? 'new'} initial={editingTable ?? undefined} onSubmit={(value) => editingTable ? update.mutate({ id: editingTable.id, value }) : create.mutate(value)} pending={create.isPending || update.isPending} error={formError} /></Card>}
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="w-full max-w-xs"><Field label="Section"><Select value={filterSection} onChange={(event) => setFilterSection(event.target.value)}><option value="ALL">All sections</option>{sections.map((section) => <option key={section} value={section}>{section}</option>)}</Select></Field></div>
      <p className="text-sm text-muted-foreground">{rows.filter((row) => row.state === 'AVAILABLE').length} available · {rows.filter((row) => row.state === 'IN_USE').length} in use · {rows.filter((row) => row.state === 'RESERVED').length} reserved</p>
    </div>
    {visible.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {visible.map((row) => <Card key={row.id} className="space-y-3 p-4">
        <div className="flex items-start justify-between"><div><h2 className="font-semibold">{row.name}</h2><p className="text-xs text-muted-foreground">{row.code}{row.section ? ` · ${row.section}` : ''} · seats {row.capacity}</p></div><span className="rounded-full border px-2 py-1 text-xs">{row.state.replace('_', ' ')}</span></div>
        {row.activeOrderCreatedAt && <p className="text-xs text-muted-foreground">Active order · {elapsedOrderTime(row.activeOrderCreatedAt, now)}</p>}
        {row.mergedOrderId && <p className="text-xs text-muted-foreground">Joined to order {row.mergedOrderId.slice(0, 8)}</p>}
        <div className="flex flex-wrap gap-2">
          {canCreateOrder && row.state !== 'UNAVAILABLE' && <Button size="sm" variant="outline" onClick={() => setState.mutate({ id: row.id, state: nextState[row.state] })} disabled={setState.isPending}>{row.state === 'AVAILABLE' ? 'Reserve' : 'Mark available'}</Button>}
          {canManage && row.state !== 'IN_USE' && <Button size="sm" variant="outline" onClick={() => setEditingTable(row)}>Edit</Button>}
          {canManage && row.state !== 'IN_USE' && <Button size="sm" variant="destructive" onClick={() => remove.mutate(row.id)} disabled={remove.isPending}>Remove</Button>}
        </div>
      </Card>)}
    </div> : <Card className="p-8 text-center text-sm text-muted-foreground">No tables in this section. Add tables to start using the floor view.</Card>}
  </div>;
}
