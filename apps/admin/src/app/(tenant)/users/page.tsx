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
import type { Outlet, RoleRow, UserRow } from '@/lib/types';
import { useCan, useMe } from '@/lib/use-me';

const schema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().optional().refine((v) => !v || v.length >= 10, 'At least 10 characters'),
  pin: z.string().optional().refine((v) => !v || /^\d{4,8}$/.test(v), '4-8 digits'),
  roleId: z.string().min(1, 'Choose a role'),
  outletId: z.string().optional(),
}).refine((v) => v.password || v.pin, { path: ['password'], message: 'Set a password, a PIN, or both' });
type Form = z.infer<typeof schema>;

const useRolesAndOutlets = () => ({
  roles: useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/v1/roles') }),
  outlets: useQuery({ queryKey: ['outlets', 'all'], queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100') }),
});

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { roles, outlets } = useRolesAndOutlets();
  const [err, setErr] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const create = useMutation({
    mutationFn: (v: Form) => api.post('/v1/users', {
      name: v.name, email: v.email, password: v.password || undefined, pin: v.pin || undefined,
      assignments: [{ roleId: v.roleId, ...(v.outletId ? { outletId: v.outletId } : {}) }],
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['subscription'] }); onDone(); },
    onError: (e) => setErr(applyServerErrors(e, setError)),
  });
  return (
    <form onSubmit={handleSubmit((v) => { setErr(null); create.mutate(v); })} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label="Name" error={errors.name?.message}><Input {...register('name')} /></Field>
      <Field label="Email" error={errors.email?.message}><Input type="email" {...register('email')} /></Field>
      <Field label="Password" error={errors.password?.message} hint="For web sign-in"><Input type="password" autoComplete="new-password" {...register('password')} /></Field>
      <Field label="POS PIN" error={errors.pin?.message} hint="For quick sign-in on devices"><Input inputMode="numeric" autoComplete="off" {...register('pin')} /></Field>
      <Field label="Role" error={errors.roleId?.message}>
        <Select className="w-full" {...register('roleId')}><option value="">Select…</option>{roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
      </Field>
      <Field label="Outlet" hint="Leave on “All outlets” for business-wide access">
        <Select className="w-full" {...register('outletId')}><option value="">All outlets</option>{outlets.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
      </Field>
      <div className="sm:col-span-2 flex items-center justify-end gap-2">
        {err && <p role="alert" className="mr-auto text-sm text-destructive">{err}</p>}
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create user'}</Button>
      </div>
    </form>
  );
}

function RolesForm({ user, onDone }: { user: UserRow; onDone: () => void }) {
  const qc = useQueryClient();
  const { roles, outlets } = useRolesAndOutlets();
  const [rows, setRows] = useState(user.roles.map((r) => ({ roleId: r.roleId, outletId: r.outletId ?? '' })));
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.put(`/v1/users/${user.id}/roles`, { assignments: rows.filter((r) => r.roleId).map((r) => ({ roleId: r.roleId, ...(r.outletId ? { outletId: r.outletId } : {}) })) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Select aria-label="Role" className="flex-1" value={r.roleId} onChange={(e) => set(i, { roleId: e.target.value })}>
            <option value="">Select role…</option>{roles.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Select aria-label="Outlet" className="flex-1" value={r.outletId} onChange={(e) => set(i, { outletId: e.target.value })}>
            <option value="">All outlets</option>{outlets.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
          <Button variant="ghost" size="sm" aria-label="Remove assignment" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>✕</Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, { roleId: '', outletId: '' }])}>Add role</Button>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save roles'}</Button>
      </div>
    </div>
  );
}

function PinForm({ user, onDone }: { user: UserRow; onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.put(`/v1/users/${user.id}/pin`, { pin }),
    onSuccess: onDone,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <div className="space-y-3">
      <Field label="New PIN" hint="4-8 digits. Also clears any lockout."><Input inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus /></Field>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button disabled={!/^\d{4,8}$/.test(pin) || save.isPending} onClick={() => save.mutate()}>Set PIN</Button>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const me = useMe().data;
  const canManage = useCan('user:manage');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ kind: 'create' } | { kind: 'roles' | 'pin'; user: UserRow } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const q = useQuery({ queryKey: ['users', page], queryFn: () => api.list<UserRow>(`/v1/users?page=${page}&limit=20`) });

  const act = useMutation({
    mutationFn: (a: { run: () => Promise<unknown>; ok: string }) => a.run().then(() => a.ok),
    onSuccess: (ok) => { setMsg({ ok: true, text: ok }); qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Failed' }),
  });
  const close = () => setModal(null);

  return (
    <>
      <PageHeader title="Users" description="Staff who can sign in. Each user has one or more roles, optionally limited to an outlet." actions={canManage && <Button onClick={() => setModal({ kind: 'create' })}>New user</Button>} />
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'mb-3 text-sm text-success' : 'mb-3 text-sm text-destructive'}>{msg.text}</p>}
      <Card>
        {q.isLoading && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (<>
          <Table>
            <thead><tr><Th>User</Th><Th>Roles</Th><Th>Status</Th>{canManage && <Th className="text-right">Actions</Th>}</tr></thead>
            <tbody>
              {q.data.items.map((u) => {
                const self = me?.kind === 'tenant' && me.userId === u.id;
                return (
                  <tr key={u.id}>
                    <Td><div className="font-medium">{u.name}{self && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}</div><div className="text-xs text-muted-foreground">{u.email}</div></Td>
                    <Td className="space-x-1">{u.roles.length ? u.roles.map((r, i) => <Badge key={i}>{r.role}{r.outletId ? ' · outlet' : ''}</Badge>) : <span className="text-muted-foreground">none</span>}</Td>
                    <Td><Badge tone={u.status === 'active' ? 'success' : 'danger'}>{u.status}</Badge></Td>
                    {canManage && <Td className="space-x-1 text-right">
                      <Button size="sm" variant="outline" onClick={() => setModal({ kind: 'roles', user: u })}>Roles</Button>
                      <Button size="sm" variant="outline" onClick={() => setModal({ kind: 'pin', user: u })}>PIN</Button>
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ run: () => api.post(`/v1/users/${u.id}/force-logout`, {}), ok: `${u.name} was signed out of all sessions` })}>Sign out</Button>
                      {!self && <Button size="sm" variant="ghost" onClick={() => {
                        const next = u.status === 'active' ? 'disabled' : 'active';
                        if (next === 'disabled' && !confirm(`Disable ${u.name}? They will be signed out immediately.`)) return;
                        act.mutate({ run: () => api.patch(`/v1/users/${u.id}`, { status: next }), ok: `${u.name} ${next === 'active' ? 'enabled' : 'disabled'}` });
                      }}>{u.status === 'active' ? 'Disable' : 'Enable'}</Button>}
                    </Td>}
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <PaginationBar p={q.data.pagination} onPage={setPage} />
        </>)}
      </Card>
      <Modal open={modal?.kind === 'create'} title="New user" onClose={close}><CreateUserForm onDone={close} /></Modal>
      <Modal open={modal?.kind === 'roles'} title={modal?.kind === 'roles' ? `Roles for ${modal.user.name}` : ''} onClose={close}>{modal?.kind === 'roles' && <RolesForm user={modal.user} onDone={close} />}</Modal>
      <Modal open={modal?.kind === 'pin'} title={modal?.kind === 'pin' ? `Set PIN for ${modal.user.name}` : ''} onClose={close}>{modal?.kind === 'pin' && <PinForm user={modal.user} onDone={close} />}</Modal>
    </>
  );
}
