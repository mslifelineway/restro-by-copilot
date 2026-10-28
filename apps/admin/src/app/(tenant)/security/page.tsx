'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ChangePasswordCard } from '@/components/change-password-card';
import { PageHeader } from '@/components/page-header';
import { ErrorBox, Loading } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { SessionRow } from '@/lib/types';
import { fmtDate } from '@/lib/utils';

export default function SecurityPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<SessionRow[]>('/v1/sessions') });
  const end = useMutation({ mutationFn: (id: string) => api.delete(`/v1/sessions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }) });
  const all = useMutation({
    mutationFn: () => api.post('/v1/auth/logout-all', {}),
    onSuccess: async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.replace('/login'); },
  });

  return (
    <>
      <PageHeader title="Account" description="Your password and the places you are signed in." />
      <div className="mb-8"><ChangePasswordCard /></div>
      <PageHeader
        title="Where you're signed in"
        description="End any session you don't recognise."
        actions={<Button variant="destructive" disabled={all.isPending} onClick={() => { if (confirm('Sign out of every device, including this one?')) all.mutate(); }}>Sign out everywhere</Button>}
      />
      <Card>
        {q.isLoading && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (
          <Table>
            <thead><tr><Th>Signed in</Th><Th>Device / browser</Th><Th>IP</Th><Th>Expires</Th><Th className="text-right">Actions</Th></tr></thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id}>
                  <Td>{fmtDate(s.createdAt)} {s.current && <Badge tone="success">this session</Badge>}</Td>
                  <Td className="max-w-xs truncate text-xs text-muted-foreground">{s.userAgent ?? 'Unknown'}{s.deviceId ? ' · registered device' : ''}</Td>
                  <Td className="font-mono text-xs">{s.ip ?? '—'}</Td>
                  <Td className="text-muted-foreground">{fmtDate(s.expiresAt)}</Td>
                  <Td className="text-right">{!s.current && <Button size="sm" variant="ghost" onClick={() => end.mutate(s.id)}>End</Button>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
