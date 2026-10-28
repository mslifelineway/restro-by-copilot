'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { PaginationBar } from '@/components/pagination-bar';
import { ErrorBox, Loading } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import type { TenantRow } from '@/lib/types';
import { fmtDate, statusTone } from '@/lib/utils';
import { useCanWrite } from '@/lib/use-me';


export default function TenantsPage() {
  const [page, setPage] = useState(1);
  const canWrite = useCanWrite();
  const q = useQuery({ queryKey: ['tenants', page], queryFn: () => api.list<TenantRow>(`/v1/platform/tenants?page=${page}&limit=20`) });

  return (
    <>
      <PageHeader
        title="Tenants"
        description="Restaurant brands on the platform."
        actions={canWrite && <Button asChild><Link href="/tenants/new">New tenant</Link></Button>}
      />
      <Card>
        {q.isLoading && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (
          <>
            <Table>
              <thead><tr><Th>Name</Th><Th>Slug</Th><Th>Plan</Th><Th>Status</Th><Th>Created</Th></tr></thead>
              <tbody>
                {q.data.items.map((t) => (
                  <tr key={t.id}>
                    <Td><Link className="font-medium text-primary hover:underline" href={`/tenants/${t.id}`}>{t.name}</Link></Td>
                    <Td className="font-mono text-xs">{t.slug}</Td>
                    <Td><Badge>{t.plan}</Badge></Td>
                    <Td><Badge tone={statusTone(t.status)}>{t.status}</Badge></Td>
                    <Td className="text-muted-foreground">{fmtDate(t.created_at)}</Td>
                  </tr>
                ))}
                {!q.data.items.length && <tr><Td colSpan={5} className="text-center text-muted-foreground">No tenants yet</Td></tr>}
              </tbody>
            </Table>
            <PaginationBar p={q.data.pagination} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
