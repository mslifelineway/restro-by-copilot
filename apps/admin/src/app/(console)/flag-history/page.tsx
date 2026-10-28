'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { PaginationBar } from '@/components/pagination-bar';
import { ErrorBox, Loading } from '@/components/query-state';
import { Card } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { FlagAuditRow } from '@/lib/types';
import { fmtDate } from '@/lib/utils';

export default function FlagHistoryPage() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['flag-history', page], queryFn: () => api.list<FlagAuditRow>(`/v1/platform/flag-history?page=${page}&limit=20`) });

  return (
    <>
      <PageHeader title="Flag history" description="Append-only record of every entitlement, plan matrix and kill-switch change." />
      <Card>
        {q.isLoading && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (
          <>
            <Table>
              <thead><tr><Th>When</Th><Th>Feature</Th><Th>Action</Th><Th>Change</Th><Th>Reason</Th></tr></thead>
              <tbody>
                {q.data.items.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.created_at)}</Td>
                    <Td className="font-mono text-xs">{r.feature_key}</Td>
                    <Td>{r.action}</Td>
                    <Td className="font-mono text-xs">{JSON.stringify(r.old_value)} → {JSON.stringify(r.new_value)}</Td>
                    <Td>{r.reason ?? '—'}</Td>
                  </tr>
                ))}
                {!q.data.items.length && <tr><Td colSpan={5} className="text-center text-muted-foreground">No changes recorded</Td></tr>}
              </tbody>
            </Table>
            <PaginationBar p={q.data.pagination} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
