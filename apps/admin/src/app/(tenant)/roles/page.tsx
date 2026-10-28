'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Field } from '@/components/field';
import { Modal } from '@/components/modal';
import { PageHeader } from '@/components/page-header';
import { PermissionEditor, type PermState } from '@/components/permission-editor';
import { ErrorBox, Loading } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';
import type { RoleRow } from '@/lib/types';
import { useCan } from '@/lib/use-me';
import { cn } from '@/lib/utils';

const toState = (r: RoleRow): PermState => Object.fromEntries(r.permissions.map((p) => [p.permission, p.limits]));
const toPayload = (s: PermState) => Object.entries(s).map(([permission, limits]) => ({ permission, ...(Object.keys(limits).length ? { limits } : {}) }));

export default function RolesPage() {
  const qc = useQueryClient();
  const canManage = useCan('role:manage');
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/v1/roles') });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PermState | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPerms, setNewPerms] = useState<PermState>({});
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0];
  const editable = !!selected && !selected.is_system && canManage;

  const refresh = () => qc.invalidateQueries({ queryKey: ['roles'] });
  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Something went wrong');
  const save = useMutation({
    mutationFn: () => api.put(`/v1/roles/${selected!.id}/permissions`, { permissions: toPayload(draft!) }),
    onSuccess: () => { setErr(null); setDraft(null); setSaved(true); refresh(); },
    onError: fail,
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/v1/roles', { name: newName.trim(), permissions: toPayload(newPerms) }),
    onSuccess: (r) => { setErr(null); setCreating(false); setNewName(''); setNewPerms({}); setSelectedId(r.id); refresh(); },
    onError: fail,
  });

  if (roles.isLoading) return <Loading />;
  if (roles.isError) return <ErrorBox error={roles.error} />;

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="System roles are fixed. Create a custom role to fine-tune access; assign it to users on the Users page."
        actions={canManage && <Button onClick={() => { setErr(null); setCreating(true); }}>New role</Button>}
      />
      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <Card className="h-fit">
          <ul>
            {roles.data!.map((r) => (
              <li key={r.id}>
                <button
                  className={cn('flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-muted', selected?.id === r.id && 'bg-muted font-medium')}
                  onClick={() => { setSelectedId(r.id); setDraft(null); setSaved(false); setErr(null); }}
                >
                  {r.name} {r.is_system && <Badge>system</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {selected && (
          <Card>
            <CardHeader>
              <span>{selected.name}</span>
              <span className="text-xs font-normal text-muted-foreground">{selected.permissions.length} permission(s)</span>
            </CardHeader>
            <CardBody className="space-y-4">
              {selected.is_system && <p className="text-sm text-muted-foreground">System roles cannot be edited. Create a custom role to change what a group of staff can do.</p>}
              <PermissionEditor value={draft ?? toState(selected)} readOnly={!editable} onChange={(v) => { setDraft(v); setSaved(false); }} />
              {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
              {saved && <p role="status" className="text-sm text-success">Saved. Changes apply to signed-in users within seconds.</p>}
              {editable && <Button disabled={!draft || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save permissions'}</Button>}
            </CardBody>
          </Card>
        )}
      </div>

      <Modal open={creating} title="New custom role" onClose={() => setCreating(false)}>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto">
          <Field label="Role name"><Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={50} autoFocus /></Field>
          <PermissionEditor value={newPerms} onChange={setNewPerms} />
        </div>
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          <Button disabled={newName.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creating…' : 'Create role'}</Button>
        </div>
      </Modal>
    </>
  );
}
