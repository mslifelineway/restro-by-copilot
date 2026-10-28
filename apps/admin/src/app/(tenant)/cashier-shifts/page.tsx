'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import { api, ApiError } from '@/lib/api';
import type { Outlet } from '@/lib/types';
import { fmtDate } from '@/lib/utils';
import { useCan, useMe } from '@/lib/use-me';

type CurrentShift = { id: string; openingCash: string; openedAt: string };
type ShiftReport = {
  id: string;
  userId: string;
  status: 'OPEN' | 'CLOSED';
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  openedAt: string;
  closedAt: string | null;
  netCashPayments: string;
  netAdjustments: string;
};

const openingSchema = z.object({
  openingCash: z.string().regex(/^(0|[1-9]\d{0,18})$/, 'Enter a whole amount in paise (0 or more)'),
});
const adjustmentSchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  amount: z.string().regex(/^[1-9]\d{0,18}$/, 'Enter an amount greater than zero in paise'),
  reason: z.string().min(3, 'Enter at least 3 characters').max(500),
});
const closingSchema = z.object({
  countedCash: z.string().regex(/^(0|[1-9]\d{0,18})$/, 'Enter a whole amount in paise (0 or more)'),
});
type OpenShiftForm = z.infer<typeof openingSchema>;
type AdjustmentForm = z.infer<typeof adjustmentSchema>;
type CloseShiftForm = z.infer<typeof closingSchema>;

function formatPaise(value: string | null) {
  if (value === null) return '—';
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const sign = amount < 0n ? '- ' : '';
  return `${sign}₹${(absolute / 100n).toLocaleString('en-IN')}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function OpenShiftFormView({ onSubmit, pending, error, onCancel }: {
  onSubmit: (values: OpenShiftForm) => void; pending: boolean; error: string | null; onCancel: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<OpenShiftForm>({
    resolver: zodResolver(openingSchema), defaultValues: { openingCash: '0' },
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Opening cash (paise)" error={errors.openingCash?.message} hint="Enter a whole number; for example, ₹100.00 is 10000 paise.">
        <Input inputMode="numeric" {...register('openingCash')} />
      </Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? 'Opening…' : 'Open shift'}</Button>
      </div>
    </form>
  );
}

function AdjustmentFormView({ onSubmit, pending, error, onCancel }: {
  onSubmit: (values: AdjustmentForm) => void; pending: boolean; error: string | null; onCancel: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<AdjustmentForm>({
    resolver: zodResolver(adjustmentSchema), defaultValues: { direction: 'IN' },
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Direction" error={errors.direction?.message}>
        <Select {...register('direction')}><option value="IN">Cash in</option><option value="OUT">Cash out</option></Select>
      </Field>
      <Field label="Amount (paise)" error={errors.amount?.message}><Input inputMode="numeric" {...register('amount')} /></Field>
      <Field label="Reason" error={errors.reason?.message}><Input maxLength={500} {...register('reason')} /></Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? 'Recording…' : 'Record adjustment'}</Button>
      </div>
    </form>
  );
}

function CloseShiftFormView({ onSubmit, pending, error, onCancel }: {
  onSubmit: (values: CloseShiftForm) => void; pending: boolean; error: string | null; onCancel: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<CloseShiftForm>({
    resolver: zodResolver(closingSchema),
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Counted cash (paise)" error={errors.countedCash?.message}>
        <Input inputMode="numeric" {...register('countedCash')} />
      </Field>
      <p className="text-sm text-muted-foreground">Enter the actual cash in the drawer. The report will show the variance against expected cash.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? 'Closing…' : 'Close shift'}</Button>
      </div>
    </form>
  );
}

export default function CashierShiftsPage() {
  const qc = useQueryClient();
  const me = useMe();
  const canReadShift = useCan('shift:read');
  const canManageShift = useCan('shift:manage');
  const canReadReport = useCan('report:read');
  const canSelectOutlet = useCan('outlet:read');
  const [outletId, setOutletId] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<'open' | 'adjust' | 'close' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const outlets = useQuery({
    queryKey: ['outlets', 'all'],
    queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100'),
    enabled: canSelectOutlet,
  });
  useEffect(() => {
    if (outletId) return;
    if (me.data?.kind === 'tenant' && me.data.outletId) setOutletId(me.data.outletId);
    else if (outlets.data?.items[0]) setOutletId(outlets.data.items[0].id);
  }, [outletId, me.data, outlets.data]);

  const headers = { 'x-outlet-id': outletId };
  const current = useQuery({
    queryKey: ['cashier-current-shift', outletId],
    queryFn: () => api.get<CurrentShift | null>('/v1/cashier-shifts/current', headers),
    enabled: !!outletId && canReadShift,
  });
  const report = useQuery({
    queryKey: ['cashier-shift-report', outletId, page],
    queryFn: () => api.list<ShiftReport>(`/v1/cashier-shifts/report?page=${page}&limit=20`, headers),
    enabled: !!outletId && canReadReport,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['cashier-current-shift', outletId] });
    qc.invalidateQueries({ queryKey: ['cashier-shift-report', outletId] });
  };
  const onError = (error: unknown) => setActionError(error instanceof ApiError ? error.message : 'Unable to update the cashier shift');
  const openShift = useMutation({
    mutationFn: (values: OpenShiftForm) => api.post('/v1/cashier-shifts', values, headers),
    onSuccess: () => { setModal(null); setActionError(null); setNotice('Cashier shift opened.'); refresh(); },
    onError,
  });
  const adjustment = useMutation({
    mutationFn: (values: AdjustmentForm) => api.post(`/v1/cashier-shifts/${current.data!.id}/adjustments`, values, headers),
    onSuccess: () => { setModal(null); setActionError(null); setNotice('Cash adjustment recorded.'); refresh(); },
    onError,
  });
  const closeShift = useMutation({
    mutationFn: (values: CloseShiftForm) => api.post(`/v1/cashier-shifts/${current.data!.id}/close`, values, headers),
    onSuccess: () => { setModal(null); setActionError(null); setNotice('Cashier shift closed.'); refresh(); },
    onError,
  });

  const outletIsMissing = !outletId && !outlets.isLoading;
  const isLoading = me.isLoading || outlets.isLoading || (!!outletId && ((canReadShift && current.isLoading) || (canReadReport && report.isLoading)));

  return (
    <>
      <PageHeader title="Cashier shifts" description="Open and reconcile your cash drawer, record adjustments, and review outlet shift history." />
      {notice && <p role="status" className="mb-3 text-sm text-success">{notice}</p>}
      {outlets.isError && <div className="mb-3"><ErrorBox error={outlets.error} /></div>}
      {canSelectOutlet && outlets.data?.items.length ? (
        <div className="mb-4 flex items-center gap-3">
          <label htmlFor="cashier-outlet" className="text-sm font-medium">Outlet</label>
          <Select id="cashier-outlet" aria-label="Outlet" value={outletId} onChange={(event) => { setOutletId(event.target.value); setPage(1); setNotice(null); }}>
            {outlets.data.items.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}
          </Select>
        </div>
      ) : null}
      {isLoading && <Loading />}
      {current.isError && <div className="mb-4"><ErrorBox error={current.error} /></div>}
      {report.isError && <div className="mb-4"><ErrorBox error={report.error} /></div>}
      {outletIsMissing && (
        <Card className="mb-6 p-4 text-sm text-muted-foreground">
          {canSelectOutlet ? 'Create an outlet before managing cashier shifts.' : 'No outlet is selected for your account. Ask an administrator to assign your account to an outlet.'}
        </Card>
      )}
      {!isLoading && !!outletId && canReadShift && !current.isError && (
        <Card className="mb-6 p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-semibold">Your active shift</h2>
              {current.data ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  Opened {fmtDate(current.data.openedAt)} · Opening cash {formatPaise(current.data.openingCash)}
                </p>
              ) : <p className="mt-1 text-sm text-muted-foreground">You do not have an open shift at this outlet.</p>}
            </div>
            {canManageShift && (
              <div className="flex flex-wrap gap-2">
                {current.data ? (
                  <>
                    <Button variant="outline" onClick={() => { setActionError(null); setModal('adjust'); }}>Add cash adjustment</Button>
                    <Button variant="destructive" onClick={() => { setActionError(null); setModal('close'); }}>Close shift</Button>
                  </>
                ) : <Button onClick={() => { setActionError(null); setModal('open'); }}>Open shift</Button>}
              </div>
            )}
          </div>
        </Card>
      )}
      {canReadReport && !!outletId && !report.isError && (
        <Card>
          {report.data && (<>
            <Table>
              <thead>
                <tr><Th>Status</Th><Th>Opened</Th><Th>Closed</Th><Th>Opening cash</Th><Th>Net cash payments</Th><Th>Net adjustments</Th><Th>Expected cash</Th><Th>Counted cash</Th><Th>Variance</Th></tr>
              </thead>
              <tbody>
                {report.data.items.map((shift) => (
                  <tr key={shift.id}>
                    <Td><Badge tone={shift.status === 'OPEN' ? 'warning' : 'neutral'}>{shift.status}</Badge><div className="mt-1 font-mono text-xs text-muted-foreground">{shift.userId.slice(0, 8)}</div></Td>
                    <Td className="whitespace-nowrap">{fmtDate(shift.openedAt)}</Td>
                    <Td className="whitespace-nowrap">{fmtDate(shift.closedAt)}</Td>
                    <Td>{formatPaise(shift.openingCash)}</Td>
                    <Td>{formatPaise(shift.netCashPayments)}</Td>
                    <Td>{formatPaise(shift.netAdjustments)}</Td>
                    <Td>{formatPaise(shift.expectedCash)}</Td>
                    <Td>{formatPaise(shift.countedCash)}</Td>
                    <Td>{formatPaise(shift.variance)}</Td>
                  </tr>
                ))}
                {!report.data.items.length && <tr><Td colSpan={9} className="text-center text-muted-foreground">No cashier shifts recorded at this outlet.</Td></tr>}
              </tbody>
            </Table>
            <PaginationBar p={report.data.pagination} onPage={setPage} />
          </>)}
        </Card>
      )}
      <Modal open={modal === 'open'} title="Open cashier shift" onClose={() => setModal(null)}>
        <OpenShiftFormView onSubmit={(values) => { setActionError(null); openShift.mutate(values); }} pending={openShift.isPending} error={actionError} onCancel={() => setModal(null)} />
      </Modal>
      <Modal open={modal === 'adjust'} title="Record cash adjustment" onClose={() => setModal(null)}>
        <AdjustmentFormView onSubmit={(values) => { setActionError(null); adjustment.mutate(values); }} pending={adjustment.isPending} error={actionError} onCancel={() => setModal(null)} />
      </Modal>
      <Modal open={modal === 'close'} title="Close cashier shift" onClose={() => setModal(null)}>
        <CloseShiftFormView onSubmit={(values) => { setActionError(null); closeShift.mutate(values); }} pending={closeShift.isPending} error={actionError} onCancel={() => setModal(null)} />
      </Modal>
    </>
  );
}
