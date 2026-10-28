'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { PaginationBar } from '@/components/pagination-bar';
import { ErrorBox, Loading } from '@/components/query-state';
import { Card } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { AuditRow } from '@/lib/types';
import { fmtDate } from '@/lib/utils';

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['audit', page], queryFn: () => api.list<AuditRow>(`/v1/audit-log?page=${page}&limit=25`) });
  return (
    <>
      <PageHeader title="Audit log" description="Who changed what, newest first. Entries cannot be edited or deleted." />
      <Card>
        {q.isLoading && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (<>
          <Table>
            <thead><tr><Th>When</Th><Th>Action</Th><Th>Target</Th><Th>By</Th></tr></thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.created_at)}</Td>
                  <Td className="font-mono text-xs">{r.action}</Td>
                  <Td className="text-xs text-muted-foreground">{r.entity ? `${r.entity} ${r.entity_id?.slice(0, 8) ?? ''}` : '—'}</Td>
                  <Td className="text-xs text-muted-foreground">{r.actor_kind === 'platform_user' ? 'Platform support' : r.actor_id?.slice(0, 8) ?? 'system'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <PaginationBar p={q.data.pagination} onPage={setPage} />
        </>)}
      </Card>
    </>
  );
}
