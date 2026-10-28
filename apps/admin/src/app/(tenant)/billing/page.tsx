'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
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

type Order = { id: string; orderType: string; status: string; createdAt: string };
type Payment = { id: string; method: PaymentMethod; amount: string; refundedAmount: string; reference: string | null; createdAt: string };
type PaymentMethod = 'CASH' | 'CARD' | 'UPI' | 'OTHER';
type Invoice = {
  id: string;
  invoiceNumber: string;
  tenantName: string;
  outletName: string;
  outletGstin: string | null;
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalTax: string;
  discountType: 'PERCENTAGE' | 'FIXED' | null;
  discountValue: string;
  discountAmount: string;
  serviceChargeAmount: string;
  serviceChargeTaxableAmount: string;
  serviceChargeTax: string;
  serviceChargeTaxCode: string | null;
  tipAmount: string;
  roundOffAmount: string;
  totalAmount: string;
  paidAmount: string;
  balanceAmount: string;
  paymentStatus: string;
  isVoided: boolean;
  createdAt: string;
  lines: Array<{
    id: string; itemName: string; variantName: string; quantity: number;
    discountAmount: string; taxableAmount: string; totalTax: string; totalAmount: string;
  }>;
  payments: Payment[];
  refunds: Array<{ id: string; method: PaymentMethod; amount: string; reason: string; createdAt: string }>;
  void: { reason: string; createdAt: string } | null;
};
type BillingSettings = {
  serviceChargeMode: 'NONE' | 'FIXED' | 'PERCENTAGE';
  serviceChargeValue: string;
  serviceChargeTaxCode: string | null;
  taxSlabs: Array<{ code: string; cgstRate: number; sgstRate: number; igstRate: number }>;
};

const amountSchema = z.string().regex(/^[1-9]\d{0,18}$/, 'Enter an amount greater than zero in paise');
const paymentSchema = z.object({
  method: z.enum(['CASH', 'CARD', 'UPI', 'OTHER']),
  amount: amountSchema,
  reference: z.string().max(100),
});
const refundSchema = z.object({
  paymentId: z.string().uuid('Choose a payment'),
  method: z.enum(['CASH', 'CARD', 'UPI', 'OTHER']),
  amount: amountSchema,
  reason: z.string().min(3, 'Enter at least 3 characters').max(500),
  reference: z.string().max(100),
});
const reasonSchema = z.object({ reason: z.string().min(3, 'Enter at least 3 characters').max(500) });
type PaymentForm = z.infer<typeof paymentSchema>;
type RefundForm = z.infer<typeof refundSchema>;
type ReasonForm = z.infer<typeof reasonSchema>;

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const methods: PaymentMethod[] = ['CASH', 'CARD', 'UPI', 'OTHER'];

function formatPaise(value: string) {
  const amount = BigInt(value);
  return `₹${(amount / 100n).toLocaleString('en-IN')}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function formatSignedPaise(value: string) {
  const amount = BigInt(value);
  if (amount === 0n) return formatPaise('0');
  return amount < 0n ? `- ${formatPaise((-amount).toString())}` : `+ ${formatPaise(value)}`;
}

function PaymentFormView({ invoice, onSubmit, pending, error }: {
  invoice: Invoice; onSubmit: (values: PaymentForm) => void; pending: boolean; error: string | null;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<PaymentForm>({
    resolver: zodResolver(paymentSchema),
    defaultValues: { method: 'CASH', amount: invoice.balanceAmount, reference: '' },
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3" noValidate>
      <Field label="Payment method" error={errors.method?.message}>
        <Select {...register('method')}><option value="CASH">Cash</option><option value="CARD">Card</option><option value="UPI">UPI</option><option value="OTHER">Other</option></Select>
      </Field>
      <Field label="Amount (paise)" error={errors.amount?.message}><Input inputMode="numeric" {...register('amount')} /></Field>
      <Field label="Reference (optional)" error={errors.reference?.message}><Input maxLength={100} {...register('reference')} /></Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={pending}>{pending ? 'Recording…' : 'Record payment'}</Button>
    </form>
  );
}

function RefundFormView({ invoice, onSubmit, pending, error }: {
  invoice: Invoice; onSubmit: (values: RefundForm) => void; pending: boolean; error: string | null;
}) {
  const refundable = invoice.payments.filter((payment) => BigInt(payment.amount) > BigInt(payment.refundedAmount));
  const [selectedPayment, setSelectedPayment] = useState(refundable[0]?.id ?? '');
  const selected = refundable.find((payment) => payment.id === selectedPayment);
  const { register, handleSubmit, setValue, formState: { errors } } = useForm<RefundForm>({
    resolver: zodResolver(refundSchema),
    defaultValues: {
      paymentId: selectedPayment,
      method: selected?.method ?? 'CASH',
      amount: selected ? (BigInt(selected.amount) - BigInt(selected.refundedAmount)).toString() : '',
      reason: '',
      reference: '',
    },
  });
  function changePayment(paymentId: string) {
    setSelectedPayment(paymentId);
    const payment = refundable.find((row) => row.id === paymentId);
    setValue('paymentId', paymentId, { shouldValidate: true });
    if (payment) {
      setValue('method', payment.method, { shouldValidate: true });
      setValue('amount', (BigInt(payment.amount) - BigInt(payment.refundedAmount)).toString());
    }
  }
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3" noValidate>
      {refundable.length ? (
        <>
          <Field label="Payment to refund" error={errors.paymentId?.message}>
            <Select value={selectedPayment} onChange={(event) => changePayment(event.target.value)}>
              {refundable.map((payment) => <option key={payment.id} value={payment.id}>{payment.method} · remaining {formatPaise((BigInt(payment.amount) - BigInt(payment.refundedAmount)).toString())}</option>)}
            </Select>
          </Field>
          <input type="hidden" {...register('paymentId')} />
          <Field label="Refund method" error={errors.method?.message}>
            <Select {...register('method')}><option value="CASH">Cash</option><option value="CARD">Card</option><option value="UPI">UPI</option><option value="OTHER">Other</option></Select>
          </Field>
          <Field label="Amount (paise)" error={errors.amount?.message}><Input inputMode="numeric" {...register('amount')} /></Field>
          <Field label="Reason" error={errors.reason?.message}><Input maxLength={500} {...register('reason')} /></Field>
          <Field label="Reference (optional)" error={errors.reference?.message}><Input maxLength={100} {...register('reference')} /></Field>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={pending}>{pending ? 'Recording…' : 'Record refund'}</Button>
        </>
      ) : <p className="text-sm text-muted-foreground">There are no refundable payments on this invoice.</p>}
    </form>
  );
}

function VoidFormView({ onSubmit, pending, error }: {
  onSubmit: (values: ReasonForm) => void; pending: boolean; error: string | null;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<ReasonForm>({ resolver: zodResolver(reasonSchema) });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3" noValidate>
      <Field label="Void reason" error={errors.reason?.message}><Input maxLength={500} {...register('reason')} /></Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" variant="destructive" disabled={pending}>{pending ? 'Voiding…' : 'Void invoice'}</Button>
    </form>
  );
}

export default function BillingPage() {
  const qc = useQueryClient();
  const me = useMe();
  const canReadOrders = useCan('order:read');
  const canCreateBill = useCan('bill:create');
  const canApplyDiscount = useCan('discount:apply');
  const canReadInvoice = useCan('bill:reprint');
  const canEditBillingSettings = useCan('tenant:update');
  const canVoid = useCan('bill:void');
  const canRefund = useCan('refund:create');
  const canSelectOutlet = useCan('outlet:read');
  const [outletId, setOutletId] = useState('');
  const [invoiceIdInput, setInvoiceIdInput] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [orderAdjustments, setOrderAdjustments] = useState<Record<string, {
    discountType: 'PERCENTAGE' | 'FIXED'; discountValue: string; tipAmount: string;
  }>>({});
  const [serviceChargeMode, setServiceChargeMode] = useState<BillingSettings['serviceChargeMode']>('NONE');
  const [serviceChargeValue, setServiceChargeValue] = useState('0');
  const [serviceChargeTaxCode, setServiceChargeTaxCode] = useState('');
  const [error, setError] = useState<string | null>(null);
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
  const orders = useQuery({
    queryKey: ['billing-ready-orders', outletId],
    queryFn: () => api.list<Order>('/v1/orders?page=1&limit=100', headers),
    enabled: !!outletId && canReadOrders,
  });
  const invoice = useQuery({
    queryKey: ['invoice', outletId, invoiceId],
    queryFn: () => api.get<Invoice>(`/v1/invoices/${invoiceId}`, headers),
    enabled: !!outletId && !!invoiceId && canReadInvoice,
  });
  const billingSettings = useQuery({
    queryKey: ['billing-settings', outletId],
    queryFn: () => api.get<BillingSettings>('/v1/billing/settings', headers),
    enabled: !!outletId && canReadInvoice,
  });
  useEffect(() => {
    if (!billingSettings.data) return;
    setServiceChargeMode(billingSettings.data.serviceChargeMode);
    setServiceChargeValue(billingSettings.data.serviceChargeValue);
    setServiceChargeTaxCode(billingSettings.data.serviceChargeTaxCode ?? '');
  }, [billingSettings.data, outletId]);

  function selectInvoice(id: string) {
    setInvoiceId(id);
    setInvoiceIdInput(id);
    setError(null);
    setNotice(null);
  }
  function mutationError(reason: unknown, fallback: string) {
    setError(reason instanceof ApiError ? reason.message : fallback);
  }
  function refreshInvoice(id = invoiceId) {
    void qc.invalidateQueries({ queryKey: ['invoice', outletId, id] });
  }
  const finalize = useMutation({
    mutationFn: ({ orderId, discountType, discountValue, tipAmount }: {
      orderId: string; discountType: 'PERCENTAGE' | 'FIXED'; discountValue: string; tipAmount: string;
    }) => api.post<{ id: string; invoiceNumber: string }>(`/v1/orders/${orderId}/invoice`, {
      ...(discountValue.trim() ? { discount: { type: discountType, value: discountValue.trim() } } : {}),
      tipAmount: tipAmount || '0',
    }, headers),
    onSuccess: (created) => {
      selectInvoice(created.id);
      setNotice(`Invoice ${created.invoiceNumber} finalized.`);
      void qc.invalidateQueries({ queryKey: ['billing-ready-orders', outletId] });
    },
    onError: (reason) => mutationError(reason, 'Unable to finalize this invoice'),
  });
  const updateBillingSettings = useMutation({
    mutationFn: () => api.put('/v1/billing/settings', {
      serviceChargeMode,
      serviceChargeValue: serviceChargeMode === 'NONE' ? '0' : serviceChargeValue.trim(),
      serviceChargeTaxCode: serviceChargeMode === 'NONE' ? null : serviceChargeTaxCode || null,
    }, headers),
    onSuccess: () => {
      setError(null);
      setNotice('Billing settings saved.');
      void qc.invalidateQueries({ queryKey: ['billing-settings', outletId] });
    },
    onError: (reason) => mutationError(reason, 'Unable to save billing settings'),
  });
  const payment = useMutation({
    mutationFn: (values: PaymentForm) => api.post(`/v1/invoices/${invoiceId}/payments`, {
      ...values, reference: values.reference || undefined,
    }, headers),
    onSuccess: () => { setError(null); setNotice('Payment recorded.'); refreshInvoice(); },
    onError: (reason) => mutationError(reason, 'Unable to record payment'),
  });
  const refund = useMutation({
    mutationFn: (values: RefundForm) => api.post(`/v1/invoices/${invoiceId}/refunds`, {
      ...values, reference: values.reference || undefined,
    }, headers),
    onSuccess: () => { setError(null); setNotice('Refund recorded.'); refreshInvoice(); },
    onError: (reason) => mutationError(reason, 'Unable to record refund'),
  });
  const voidInvoice = useMutation({
    mutationFn: (values: ReasonForm) => api.post(`/v1/invoices/${invoiceId}/void`, values, headers),
    onSuccess: () => { setError(null); setNotice('Invoice voided.'); refreshInvoice(); },
    onError: (reason) => mutationError(reason, 'Unable to void invoice'),
  });

  const readyOrders = orders.data?.items.filter((order) => order.status === 'READY') ?? [];
  const viewedInvoice = invoice.data;
  const isPending = finalize.isPending || updateBillingSettings.isPending
    || payment.isPending || refund.isPending || voidInvoice.isPending;

  if (me.isLoading || (canSelectOutlet && outlets.isLoading)) return <Loading />;
  if (me.isError) return <ErrorBox error={me.error} />;
  if (canSelectOutlet && outlets.isError) return <ErrorBox error={outlets.error} />;

  return (
    <div>
      <PageHeader title="Billing" description="Finalize ready orders, record payments, and manage invoice corrections." />
      {notice && <p role="status" className="mb-4 text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      {canSelectOutlet && outlets.data && (
        <div className="mb-4 max-w-sm">
          <Field label="Outlet">
            <Select value={outletId} onChange={(event) => { setOutletId(event.target.value); setInvoiceId(''); }}>
              {outlets.data.items.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}
            </Select>
          </Field>
        </div>
      )}

      {canReadInvoice && outletId && (
        <Card className="mb-6 space-y-3 p-4">
          <h2 className="text-lg font-semibold">Service charge settings</h2>
          <p className="text-sm text-muted-foreground">
            Optional outlet-level charge. A selected GST slab is extracted from the charge amount; without a slab, the charge has no GST.
          </p>
          {billingSettings.isLoading ? <Loading /> : billingSettings.isError ? <ErrorBox error={billingSettings.error} /> : billingSettings.data && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Service charge">
                  <Select disabled={!canEditBillingSettings} value={serviceChargeMode}
                    onChange={(event) => setServiceChargeMode(event.target.value as BillingSettings['serviceChargeMode'])}>
                    <option value="NONE">None</option><option value="FIXED">Fixed amount</option><option value="PERCENTAGE">Percentage</option>
                  </Select>
                </Field>
                {serviceChargeMode !== 'NONE' && (
                  <>
                    <Field label={serviceChargeMode === 'FIXED' ? 'Amount (paise)' : 'Rate (%)'}>
                      <Input disabled={!canEditBillingSettings} inputMode={serviceChargeMode === 'FIXED' ? 'numeric' : 'decimal'}
                        value={serviceChargeValue} onChange={(event) => setServiceChargeValue(event.target.value)} />
                    </Field>
                    <Field label="GST treatment">
                      <Select disabled={!canEditBillingSettings} value={serviceChargeTaxCode}
                        onChange={(event) => setServiceChargeTaxCode(event.target.value)}>
                        <option value="">No GST</option>
                        {billingSettings.data.taxSlabs.map((slab) => (
                          <option key={slab.code} value={slab.code}>{slab.code} · {(slab.igstRate / 100).toFixed(2)}%</option>
                        ))}
                      </Select>
                    </Field>
                  </>
                )}
              </div>
              {canEditBillingSettings
                ? <Button type="button" onClick={() => updateBillingSettings.mutate()} disabled={updateBillingSettings.isPending}>
                  {updateBillingSettings.isPending ? 'Saving…' : 'Save billing settings'}
                </Button>
                : <p className="text-sm text-muted-foreground">Only a tenant administrator can change billing settings.</p>}
            </>
          )}
        </Card>
      )}

      {canReadOrders && (
        <Card className="mb-6 p-4">
          <h2 className="mb-3 text-lg font-semibold">Ready orders</h2>
          {canCreateBill && <p className="mb-3 text-sm text-muted-foreground">
            {canApplyDiscount ? 'Optional discounts apply before GST. Enter percentage discounts as a percentage; fixed discounts and tips are integer paise.' : 'Tips are integer paise. Your role does not allow discounts.'}
          </p>}
          {orders.isLoading ? <Loading /> : orders.isError ? <ErrorBox error={orders.error} /> : readyOrders.length ? (
            <Table>
              <thead><tr><Th>Order</Th><Th>Type</Th><Th>Created</Th>{canCreateBill && <>{canApplyDiscount && <><Th>Discount type</Th><Th>Discount</Th></>}<Th>Tip (paise)</Th><Th>Action</Th></>}</tr></thead>
              <tbody>{readyOrders.map((order) => (
                <tr key={order.id}>
                  <Td><code>{order.id}</code></Td><Td>{order.orderType.replace('_', ' ')}</Td><Td>{fmtDate(order.createdAt)}</Td>
                  {canCreateBill && (() => {
                    const adjustment = orderAdjustments[order.id] ?? { discountType: 'PERCENTAGE' as const, discountValue: '', tipAmount: '0' };
                    return <>
                      {canApplyDiscount && <>
                        <Td><Select aria-label={`Discount type for ${order.id}`} value={adjustment.discountType}
                          onChange={(event) => setOrderAdjustments((current) => ({
                            ...current, [order.id]: { ...adjustment, discountType: event.target.value as 'PERCENTAGE' | 'FIXED' },
                          }))}>
                          <option value="PERCENTAGE">Percent</option><option value="FIXED">Fixed</option>
                        </Select></Td>
                        <Td><Input aria-label={`Discount value for ${order.id}`} inputMode={adjustment.discountType === 'FIXED' ? 'numeric' : 'decimal'}
                          value={adjustment.discountValue}
                          onChange={(event) => setOrderAdjustments((current) => ({
                            ...current, [order.id]: { ...adjustment, discountValue: event.target.value },
                          }))} /></Td>
                      </>}
                      <Td><Input aria-label={`Tip amount for ${order.id}`} inputMode="numeric" value={adjustment.tipAmount}
                        onChange={(event) => setOrderAdjustments((current) => ({
                          ...current, [order.id]: { ...adjustment, tipAmount: event.target.value },
                        }))} /></Td>
                      <Td><Button size="sm" onClick={() => finalize.mutate({ orderId: order.id, ...adjustment })} disabled={isPending}>Finalize invoice</Button></Td>
                    </>;
                  })()}
                </tr>
              ))}</tbody>
            </Table>
          ) : <p className="text-sm text-muted-foreground">No ready orders are available to invoice.</p>}
          {orders.data && orders.data.pagination.totalItems > orders.data.items.length && (
            <p className="mt-3 text-sm text-muted-foreground">Showing the first {orders.data.items.length} orders. Complete or review recent orders in the POS workflow.</p>
          )}
        </Card>
      )}

      {canReadInvoice && (
        <Card className="mb-6 p-4">
          <h2 className="mb-3 text-lg font-semibold">Find an invoice</h2>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
            event.preventDefault();
            const id = invoiceIdInput.trim();
            if (!uuidPattern.test(id)) { setError('Enter a valid invoice UUID'); return; }
            selectInvoice(id);
          }}>
            <div className="min-w-64 flex-1">
              <Field label="Invoice ID">
                <Input value={invoiceIdInput} onChange={(event) => setInvoiceIdInput(event.target.value)} placeholder="Paste invoice UUID" />
              </Field>
            </div>
            <Button type="submit">Load invoice</Button>
          </form>
        </Card>
      )}

      {invoiceId && invoice.isLoading && <Loading />}
      {invoiceId && invoice.isError && <ErrorBox error={invoice.error} />}
      {viewedInvoice && (
        <div className="space-y-6">
          <Card data-print-invoice className="space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">{viewedInvoice.tenantName}</h2>
                <p className="text-sm">{viewedInvoice.outletName}</p>
                {viewedInvoice.outletGstin && <p className="text-sm">GSTIN: {viewedInvoice.outletGstin}</p>}
                <p className="text-sm">{viewedInvoice.invoiceNumber} · {fmtDate(viewedInvoice.createdAt)}</p>
              </div>
              <div className="flex items-center gap-3" data-print-hide>
                <Badge>{viewedInvoice.isVoided ? 'VOIDED' : viewedInvoice.paymentStatus}</Badge>
                <Button type="button" variant="outline" onClick={() => window.print()}>Print invoice</Button>
              </div>
            </div>
            <Table>
              <thead><tr><Th>Item</Th><Th>Qty</Th><Th>Discount</Th><Th>Taxable</Th><Th>GST</Th><Th>Total</Th></tr></thead>
              <tbody>{viewedInvoice.lines.map((line) => (
                <tr key={line.id}>
                  <Td>{line.itemName} · {line.variantName}</Td>
                  <Td>{line.quantity}</Td>
                  <Td>{line.discountAmount === '0' ? '—' : `- ${formatPaise(line.discountAmount)}`}</Td>
                  <Td>{formatPaise(line.taxableAmount)}</Td>
                  <Td>{formatPaise(line.totalTax)}</Td>
                  <Td>{formatPaise(line.totalAmount)}</Td>
                </tr>
              ))}</tbody>
              <tfoot>
                {BigInt(viewedInvoice.discountAmount) > 0n && <tr><Td colSpan={5}>Total discount</Td><Td>- {formatPaise(viewedInvoice.discountAmount)}</Td></tr>}
                <tr><Td colSpan={5}>Taxable amount</Td><Td>{formatPaise(viewedInvoice.taxableAmount)}</Td></tr>
                {BigInt(viewedInvoice.serviceChargeAmount) > 0n && <tr><Td colSpan={5}>Service charge</Td><Td>{formatPaise(viewedInvoice.serviceChargeAmount)}</Td></tr>}
                {BigInt(viewedInvoice.serviceChargeTax) > 0n && <tr><Td colSpan={5}>GST on service charge ({viewedInvoice.serviceChargeTaxCode}; included in GST totals)</Td><Td>{formatPaise(viewedInvoice.serviceChargeTax)}</Td></tr>}
                <tr><Td colSpan={5}>CGST</Td><Td>{formatPaise(viewedInvoice.cgstAmount)}</Td></tr>
                <tr><Td colSpan={5}>SGST</Td><Td>{formatPaise(viewedInvoice.sgstAmount)}</Td></tr>
                <tr><Td colSpan={5}>IGST</Td><Td>{formatPaise(viewedInvoice.igstAmount)}</Td></tr>
                <tr><Td colSpan={5}>Total GST</Td><Td>{formatPaise(viewedInvoice.totalTax)}</Td></tr>
                {BigInt(viewedInvoice.tipAmount) > 0n && <tr><Td colSpan={5}>Tip (non-taxable)</Td><Td>{formatPaise(viewedInvoice.tipAmount)}</Td></tr>}
                <tr><Td colSpan={5}>Round off</Td><Td>{formatSignedPaise(viewedInvoice.roundOffAmount)}</Td></tr>
                <tr><Td colSpan={5}>Invoice total</Td><Td>{formatPaise(viewedInvoice.totalAmount)}</Td></tr>
                <tr><Td colSpan={5}>Paid</Td><Td>{formatPaise(viewedInvoice.paidAmount)}</Td></tr>
                <tr><Td colSpan={5}>Balance due</Td><Td>{formatPaise(viewedInvoice.balanceAmount)}</Td></tr>
              </tfoot>
            </Table>
            {viewedInvoice.isVoided && viewedInvoice.void && <p className="text-sm">VOIDED · {viewedInvoice.void.reason}</p>}
            <p className="text-center text-sm">Thank you for dining with us.</p>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2" data-print-hide>
            {canCreateBill && !viewedInvoice.isVoided && BigInt(viewedInvoice.balanceAmount) > 0n && (
              <Card className="space-y-3 p-4">
                <h2 className="text-lg font-semibold">Record payment</h2>
                <p className="text-sm text-muted-foreground">Balance due: {formatPaise(viewedInvoice.balanceAmount)}. Cash payments require your open cashier shift.</p>
                <PaymentFormView key={`${viewedInvoice.id}-${viewedInvoice.balanceAmount}`} invoice={viewedInvoice} onSubmit={(values) => payment.mutate(values)} pending={payment.isPending} error={payment.error instanceof ApiError ? payment.error.message : null} />
              </Card>
            )}
            {canRefund && !viewedInvoice.isVoided && viewedInvoice.payments.length > 0 && (
              <Card className="space-y-3 p-4">
                <h2 className="text-lg font-semibold">Record refund</h2>
                <p className="text-sm text-muted-foreground">Refunds are capped at each payment&apos;s remaining refundable amount.</p>
                <RefundFormView key={`${viewedInvoice.id}-${viewedInvoice.payments.map((row) => row.refundedAmount).join(',')}`} invoice={viewedInvoice} onSubmit={(values) => refund.mutate(values)} pending={refund.isPending} error={refund.error instanceof ApiError ? refund.error.message : null} />
              </Card>
            )}
            {canVoid && !viewedInvoice.isVoided && (
              <Card className="space-y-3 p-4">
                <h2 className="text-lg font-semibold">Void invoice</h2>
                <p className="text-sm text-muted-foreground">An invoice can only be voided after its net payments have been fully refunded.</p>
                <VoidFormView onSubmit={(values) => voidInvoice.mutate(values)} pending={voidInvoice.isPending} error={voidInvoice.error instanceof ApiError ? voidInvoice.error.message : null} />
              </Card>
            )}
          </div>

          <Card className="p-4">
            <h2 className="mb-3 text-lg font-semibold">Payment history</h2>
            {viewedInvoice.payments.length ? (
              <Table><thead><tr><Th>Method</Th><Th>Amount</Th><Th>Refunded</Th><Th>Reference</Th><Th>Date</Th></tr></thead>
                <tbody>{viewedInvoice.payments.map((row) => <tr key={row.id}><Td>{row.method}</Td><Td>{formatPaise(row.amount)}</Td><Td>{formatPaise(row.refundedAmount)}</Td><Td>{row.reference ?? '—'}</Td><Td>{fmtDate(row.createdAt)}</Td></tr>)}</tbody>
              </Table>
            ) : <p className="text-sm text-muted-foreground">No payments recorded.</p>}
            {viewedInvoice.refunds.length > 0 && <div className="mt-4"><h3 className="mb-2 font-medium">Refunds</h3><ul className="space-y-1 text-sm">{viewedInvoice.refunds.map((row) => <li key={row.id}>{row.method} · {formatPaise(row.amount)} · {row.reason} · {fmtDate(row.createdAt)}</li>)}</ul></div>}
          </Card>
        </div>
      )}
    </div>
  );
}
