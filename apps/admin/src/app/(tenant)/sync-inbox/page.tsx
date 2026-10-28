'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/modal';
import { PageHeader } from '@/components/page-header';
import { PaginationBar } from '@/components/pagination-bar';
import { ErrorBox, Loading } from '@/components/query-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { useCan } from '@/lib/use-me';
import { fmtDate } from '@/lib/utils';
import type { Outlet } from '@/lib/types';

type InboxStatus = 'RECEIVED' | 'RESOLVED' | 'REJECTED';
type SyncEvent = {
  id: string;
  deviceId: string;
  deviceSeq: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  clockSkewSeconds: number;
  payload: Record<string, unknown>;
  status: InboxStatus;
  resolutionNote: string | null;
};

export default function SyncInboxPage() {
  const qc = useQueryClient();
  const canResolve = useCan('device:manage');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<InboxStatus>('RECEIVED');
  const [outletId, setOutletId] = useState('');
  const [selected, setSelected] = useState<SyncEvent | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const outlets = useQuery({ queryKey: ['outlets', 'all'], queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100') });
  useEffect(() => {
    if (!outletId && outlets.data?.items[0]) setOutletId(outlets.data.items[0].id);
  }, [outletId, outlets.data]);
  const q = useQuery({
    queryKey: ['sync-inbox', outletId, status, page],
    enabled: !!outletId,
    queryFn: () => api.list<SyncEvent>(`/v1/sync/events?status=${status}&page=${page}&limit=20`, { 'x-outlet-id': outletId }),
  });
  const resolve = useMutation({
    mutationFn: (nextStatus: 'RESOLVED' | 'REJECTED') =>
      api.post(`/v1/sync/events/${selected!.id}/resolve`, { status: nextStatus, note: note.trim() }, { 'x-outlet-id': outletId }),
    onSuccess: () => {
      setSelected(null);
      setNote('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['sync-inbox', outletId] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Unable to update the event'),
  });

  return (
    <>
      <PageHeader title="Offline sync inbox" description="Review device-uploaded events. Receiving an event does not apply it to orders or payments." />
      {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      <Card>
        <div className="flex items-center justify-between gap-3 border-b p-4">
          <p className="text-sm text-muted-foreground">Events are immutable; resolution adds an audited disposition.</p>
          <div className="flex gap-2">
            <Select aria-label="Outlet" value={outletId} onChange={(event) => { setOutletId(event.target.value); setPage(1); }}>
              {outlets.data?.items.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}
            </Select>
            <Select aria-label="Inbox status" value={status} onChange={(event) => { setStatus(event.target.value as InboxStatus); setPage(1); }}>
              <option value="RECEIVED">Awaiting review</option>
              <option value="RESOLVED">Resolved</option>
              <option value="REJECTED">Rejected</option>
            </Select>
          </div>
        </div>
        {outlets.isError && <div className="p-4"><ErrorBox error={outlets.error} /></div>}
        {outlets.data && !outlets.data.items.length && <p className="p-4 text-sm text-muted-foreground">Create an outlet before using sync review.</p>}
        {(outlets.isLoading || (!!outletId && q.isLoading)) && <Loading />}
        {q.isError && <div className="p-4"><ErrorBox error={q.error} /></div>}
        {q.data && (<>
          <Table>
            <thead><tr><Th>Received</Th><Th>Event</Th><Th>Device / sequence</Th><Th>Clock skew</Th><Th>Status</Th><Th>Payload</Th>{canResolve && status === 'RECEIVED' && <Th>Action</Th>}</tr></thead>
            <tbody>
              {q.data.items.map((event) => (
                <tr key={event.id}>
                  <Td className="whitespace-nowrap text-muted-foreground">{fmtDate(event.receivedAt)}</Td>
                  <Td><div className="font-medium">{event.eventType}</div><div className="font-mono text-xs text-muted-foreground">{event.eventId.slice(0, 8)}</div></Td>
                  <Td><div className="font-mono text-xs">{event.deviceId.slice(0, 8)}</div><div className="text-xs text-muted-foreground">Seq {event.deviceSeq}</div></Td>
                  <Td>{Math.abs(event.clockSkewSeconds) > 300 ? <Badge tone="danger">{event.clockSkewSeconds}s</Badge> : `${event.clockSkewSeconds}s`}</Td>
                  <Td><Badge tone={event.status === 'RECEIVED' ? 'warning' : event.status === 'RESOLVED' ? 'success' : 'danger'}>{event.status}</Badge>{event.resolutionNote && <div className="mt-1 max-w-48 text-xs text-muted-foreground">{event.resolutionNote}</div>}</Td>
                  <Td><details><summary className="cursor-pointer text-xs underline">View</summary><pre className="mt-2 max-h-48 max-w-md overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(event.payload, null, 2)}</pre></details></Td>
                  {canResolve && status === 'RECEIVED' && <Td><Button size="sm" variant="outline" onClick={() => { setSelected(event); setNote(''); setError(null); }}>Review</Button></Td>}
                </tr>
              ))}
              {!q.data.items.length && <tr><Td colSpan={7} className="text-center text-muted-foreground">No offline events in this status</Td></tr>}
            </tbody>
          </Table>
          <PaginationBar p={q.data.pagination} onPage={setPage} />
        </>)}
      </Card>
      <Modal open={selected !== null} title="Review offline event" onClose={() => setSelected(null)}>
        {selected && (
          <div className="space-y-4">
            <div className="rounded-md bg-muted p-3 text-sm">
              <p><span className="font-medium">Type:</span> {selected.eventType}</p>
              <p><span className="font-medium">Device sequence:</span> {selected.deviceSeq}</p>
              <p className="mt-2 text-muted-foreground">This action records your review only; it does not apply the payload to live business records.</p>
            </div>
            <label className="block space-y-1 text-sm font-medium" htmlFor="resolution-note">
              Resolution note
              <textarea
                id="resolution-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                className="min-h-24 w-full rounded-md border bg-card p-3 text-sm font-normal"
                required
              />
            </label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button>
              <Button variant="destructive" disabled={note.trim().length < 3 || resolve.isPending} onClick={() => resolve.mutate('REJECTED')}>Reject</Button>
              <Button disabled={note.trim().length < 3 || resolve.isPending} onClick={() => resolve.mutate('RESOLVED')}>Mark resolved</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
