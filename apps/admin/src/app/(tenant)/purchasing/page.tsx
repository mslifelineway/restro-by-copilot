'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Modal } from '@/components/modal';
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

type InventoryItem = { id: string; name: string; baseUnit: string; reorderLevel: string; onHand: string };
type Supplier = { id: string; name: string; phone: string | null; email: string | null; createdAt: string };
type PurchaseOrderLine = {
  id: string;
  inventoryItemId: string;
  itemName: string;
  orderedQuantity: string;
  receivedQuantity: string;
  unitCostPaise: string;
};
type PurchaseOrder = {
  id: string;
  status: 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
  notes: string;
  createdAt: string;
  supplierId: string;
  supplierName: string;
  lines: PurchaseOrderLine[];
};

const quantityPattern = /^(?:0*[1-9]\d{0,14}(?:\.\d{1,3})?|0+\.\d{1,3})$/;
const moneyPattern = /^(0|[1-9]\d{0,18})$/;
const supplierSchema = z.object({
  name: z.string().min(2).max(160),
  phone: z.string().max(40),
  email: z.union([z.literal(''), z.string().email().max(254)]),
});
const inventorySchema = z.object({
  name: z.string().min(2, 'Enter at least 2 characters').max(100),
  baseUnit: z.enum(['KG', 'G', 'L', 'ML', 'EA', 'UNIT']),
  reorderLevel: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/, 'Enter a non-negative quantity with up to 3 decimals'),
});
const purchaseOrderSchema = z.object({
  supplierId: z.string().uuid('Select a supplier'),
  notes: z.string().max(500),
  lines: z.array(z.object({
    inventoryItemId: z.string().uuid('Select an inventory item'),
    quantity: z.string().regex(quantityPattern, 'Enter a quantity greater than zero'),
    unitCostPaise: z.string().regex(moneyPattern, 'Enter a whole amount in paise'),
  })).min(1, 'Add at least one inventory item'),
}).superRefine(({ lines }, ctx) => {
  const ids = lines.map((line) => line.inventoryItemId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['lines'], message: 'An inventory item can only appear once per order' });
});
const receiveSchema = z.object({
  reference: z.string().max(100),
  lines: z.array(z.object({
    purchaseOrderLineId: z.string().uuid(),
    quantity: z.string().optional(),
  })).refine((lines) => lines.some((line) => line.quantity?.trim()), 'Enter a quantity for at least one item').superRefine((lines, ctx) => {
    lines.forEach((line, index) => {
      if (line.quantity?.trim() && !quantityPattern.test(line.quantity)) {
        ctx.addIssue({ code: 'custom', path: [index, 'quantity'], message: 'Enter a quantity greater than zero (up to 3 decimals)' });
      }
    });
  }),
});

type SupplierForm = z.infer<typeof supplierSchema>;
type InventoryForm = z.infer<typeof inventorySchema>;
type PurchaseOrderForm = z.infer<typeof purchaseOrderSchema>;
type ReceiveForm = z.infer<typeof receiveSchema>;

function milli(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole || '0') * 1000n + BigInt(fraction.padEnd(3, '0'));
}

function formatMilli(value: bigint) {
  const whole = value / 1000n;
  const fraction = (value % 1000n).toString().padStart(3, '0');
  return `${whole}.${fraction}`;
}

function formatPaise(value: string) {
  const amount = BigInt(value);
  return `₹${(amount / 100n).toLocaleString('en-IN')}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function SupplierFormView({ onSubmit, pending, error, onCancel }: {
  onSubmit: (values: SupplierForm) => void; pending: boolean; error: string | null; onCancel: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<SupplierForm>({
    resolver: zodResolver(supplierSchema), defaultValues: { phone: '', email: '' },
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Supplier name" error={errors.name?.message}><Input {...register('name')} /></Field>
      <Field label="Phone (optional)" error={errors.phone?.message}><Input {...register('phone')} /></Field>
      <Field label="Email (optional)" error={errors.email?.message}><Input type="email" {...register('email')} /></Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save supplier'}</Button>
      </div>
    </form>
  );
}

function InventoryFormView({ onSubmit, pending, error, onCancel }: {
  onSubmit: (values: InventoryForm) => void; pending: boolean; error: string | null; onCancel: () => void;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<InventoryForm>({
    resolver: zodResolver(inventorySchema), defaultValues: { baseUnit: 'KG', reorderLevel: '0' },
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Item name" error={errors.name?.message}><Input {...register('name')} /></Field>
      <Field label="Base unit" error={errors.baseUnit?.message}>
        <Select {...register('baseUnit')}>
          {['KG', 'G', 'L', 'ML', 'EA', 'UNIT'].map((unit) => <option key={unit} value={unit}>{unit}</option>)}
        </Select>
      </Field>
      <Field label="Reorder level" error={errors.reorderLevel?.message} hint="Quantity at or below which the item needs replenishment.">
        <Input inputMode="decimal" {...register('reorderLevel')} />
      </Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Create item'}</Button>
      </div>
    </form>
  );
}

function PurchaseOrderFormView({ suppliers, items, onSubmit, pending, error, onCancel }: {
  suppliers: Supplier[]; items: InventoryItem[]; onSubmit: (values: PurchaseOrderForm) => void;
  pending: boolean; error: string | null; onCancel: () => void;
}) {
  const { register, control, handleSubmit, formState: { errors } } = useForm<PurchaseOrderForm>({
    resolver: zodResolver(purchaseOrderSchema),
    defaultValues: { notes: '', lines: [{ inventoryItemId: '', quantity: '', unitCostPaise: '0' }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Supplier" error={errors.supplierId?.message}>
        <Select {...register('supplierId')}>
          <option value="">Select supplier</option>
          {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
        </Select>
      </Field>
      <Field label="Notes" error={errors.notes?.message}><Input maxLength={500} {...register('notes')} /></Field>
      <div className="space-y-3">
        {fields.map((field, index) => (
          <div key={field.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
            <Field label={`Item ${index + 1}`} error={errors.lines?.[index]?.inventoryItemId?.message}>
              <Select {...register(`lines.${index}.inventoryItemId`)}>
                <option value="">Select item</option>
                {items.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.baseUnit})</option>)}
              </Select>
            </Field>
            <Field label="Quantity" error={errors.lines?.[index]?.quantity?.message}>
              <Input inputMode="decimal" placeholder="0.000" {...register(`lines.${index}.quantity`)} />
            </Field>
            <Field label="Unit cost (paise)" error={errors.lines?.[index]?.unitCostPaise?.message}>
              <Input inputMode="numeric" {...register(`lines.${index}.unitCostPaise`)} />
            </Field>
            <Button type="button" variant="ghost" className="self-end" onClick={() => remove(index)} disabled={fields.length === 1}>Remove</Button>
          </div>
        ))}
        {errors.lines?.root?.message && <p role="alert" className="text-sm text-destructive">{errors.lines.root.message}</p>}
        <Button type="button" variant="outline" disabled={fields.length >= 100} onClick={() => append({ inventoryItemId: '', quantity: '', unitCostPaise: '0' })}>Add item</Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending || !suppliers.length || !items.length}>{pending ? 'Creating…' : 'Create purchase order'}</Button>
      </div>
    </form>
  );
}

function ReceiveFormView({ order, onSubmit, pending, error, onCancel }: {
  order: PurchaseOrder; onSubmit: (values: ReceiveForm) => void; pending: boolean; error: string | null; onCancel: () => void;
}) {
  const receivableLines = order.lines.map((line) => ({
    ...line, remaining: formatMilli(milli(line.orderedQuantity) - milli(line.receivedQuantity)),
  })).filter((line) => milli(line.orderedQuantity) > milli(line.receivedQuantity));
  const { register, handleSubmit, formState: { errors } } = useForm<ReceiveForm>({
    resolver: zodResolver(receiveSchema),
    defaultValues: { reference: '', lines: receivableLines.map((line) => ({ purchaseOrderLineId: line.id, quantity: '' })) },
  });
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field label="Receipt reference (optional)" error={errors.reference?.message}><Input maxLength={100} {...register('reference')} /></Field>
      {receivableLines.map((line, index) => (
        <Field key={line.id} label={`${line.itemName} — ${line.receivedQuantity} received, ${line.remaining} remaining`} error={errors.lines?.[index]?.quantity?.message}>
          <input type="hidden" {...register(`lines.${index}.purchaseOrderLineId`)} />
          <Input inputMode="decimal" placeholder="Quantity received" {...register(`lines.${index}.quantity`)} />
        </Field>
      ))}
      {errors.lines?.message && <p role="alert" className="text-sm text-destructive">{errors.lines.message}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? 'Recording…' : 'Record receipt'}</Button>
      </div>
    </form>
  );
}

export default function PurchasingPage() {
  const qc = useQueryClient();
  const me = useMe();
  const canAdjust = useCan('inventory:adjust');
  const canSelectOutlet = useCan('outlet:read');
  const [outletId, setOutletId] = useState('');
  const [modal, setModal] = useState<'supplier' | 'item' | 'order' | null>(null);
  const [receiving, setReceiving] = useState<PurchaseOrder | null>(null);
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
  const enabled = !!outletId;
  const items = useQuery({ queryKey: ['inventory-items', outletId], queryFn: () => api.get<InventoryItem[]>('/v1/inventory/items', headers), enabled });
  const suppliers = useQuery({ queryKey: ['purchasing-suppliers', outletId], queryFn: () => api.get<Supplier[]>('/v1/purchasing/suppliers', headers), enabled });
  const orders = useQuery({ queryKey: ['purchase-orders', outletId], queryFn: () => api.get<PurchaseOrder[]>('/v1/purchasing/orders', headers), enabled });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['inventory-items', outletId] });
    qc.invalidateQueries({ queryKey: ['purchasing-suppliers', outletId] });
    qc.invalidateQueries({ queryKey: ['purchase-orders', outletId] });
  };
  const onError = (reason: unknown) => setError(reason instanceof ApiError ? reason.message : 'Unable to complete the purchasing action');
  const createSupplier = useMutation({
    mutationFn: (values: SupplierForm) => api.post('/v1/purchasing/suppliers', {
      name: values.name, phone: values.phone || undefined, email: values.email || undefined,
    }, headers),
    onSuccess: () => { setModal(null); setError(null); setNotice('Supplier created.'); invalidate(); },
    onError,
  });
  const createItem = useMutation({
    mutationFn: (values: InventoryForm) => api.post('/v1/inventory/items', values, headers),
    onSuccess: () => { setModal(null); setError(null); setNotice('Inventory item created.'); invalidate(); },
    onError,
  });
  const createOrder = useMutation({
    mutationFn: (values: PurchaseOrderForm) => api.post('/v1/purchasing/orders', {
        ...values,
        notes: values.notes || undefined,
    }, headers),
    onSuccess: () => { setModal(null); setError(null); setNotice('Purchase order created.'); invalidate(); },
    onError,
  });
  const receive = useMutation({
    mutationFn: ({ order, values }: { order: PurchaseOrder; values: ReceiveForm }) => api.post(`/v1/purchasing/orders/${order.id}/receipts`, {
      reference: values.reference || undefined,
      lines: values.lines.filter((line) => line.quantity?.trim()).map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity })),
    }, headers),
    onSuccess: () => { setReceiving(null); setError(null); setNotice('Stock receipt recorded.'); invalidate(); },
    onError,
  });
  const cancelOrder = useMutation({
    mutationFn: (id: string) => api.post(`/v1/purchasing/orders/${id}/cancel`, {}, headers),
    onSuccess: () => { setError(null); setNotice('Purchase order cancelled.'); invalidate(); },
    onError,
  });

  const loading = me.isLoading || outlets.isLoading || (enabled && (items.isLoading || suppliers.isLoading || orders.isLoading));
  const queryError = items.error ?? suppliers.error ?? orders.error;
  const outletMissing = !outletId && !outlets.isLoading;
  return (
    <>
      <PageHeader
        title="Inventory & purchasing"
        description="Maintain outlet inventory items, suppliers, purchase orders, and stock receipts."
        actions={canAdjust && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { setError(null); setModal('item'); }} disabled={!outletId}>New inventory item</Button>
            <Button variant="outline" onClick={() => { setError(null); setModal('supplier'); }} disabled={!outletId}>New supplier</Button>
            <Button onClick={() => { setError(null); setModal('order'); }} disabled={!outletId || !items.data?.length || !suppliers.data?.length}>New purchase order</Button>
          </div>
        )}
      />
      {notice && <p role="status" className="mb-3 text-sm text-success">{notice}</p>}
      {outlets.isError && <div className="mb-3"><ErrorBox error={outlets.error} /></div>}
      {canSelectOutlet && outlets.data?.items.length ? (
        <div className="mb-4 flex items-center gap-3">
          <label htmlFor="purchasing-outlet" className="text-sm font-medium">Outlet</label>
          <Select id="purchasing-outlet" aria-label="Outlet" value={outletId} onChange={(event) => { setOutletId(event.target.value); setNotice(null); }}>
            {outlets.data.items.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}
          </Select>
        </div>
      ) : null}
      {loading && <Loading />}
      {queryError && <div className="mb-4"><ErrorBox error={queryError} /></div>}
      {outletMissing && <Card className="mb-4 p-4 text-sm text-muted-foreground">{canSelectOutlet ? 'Create an outlet before managing inventory.' : 'No outlet is selected for your account. Ask an administrator to assign your account to an outlet.'}</Card>}
      {error && !modal && !receiving && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      {items.data && (
        <Card className="mb-6">
          <h2 className="border-b p-4 font-semibold">Inventory items</h2>
          <Table>
            <thead><tr><Th>Item</Th><Th>On hand</Th><Th>Reorder level</Th><Th>Unit</Th></tr></thead>
            <tbody>
              {items.data.map((item) => (
                <tr key={item.id}>
                  <Td className="font-medium">{item.name}</Td><Td>{item.onHand}</Td><Td>{item.reorderLevel}</Td><Td>{item.baseUnit}</Td>
                </tr>
              ))}
              {!items.data.length && <tr><Td colSpan={4} className="text-center text-muted-foreground">No inventory items yet.</Td></tr>}
            </tbody>
          </Table>
        </Card>
      )}
      {orders.data && (
        <Card>
          <h2 className="border-b p-4 font-semibold">Purchase orders</h2>
          <Table>
            <thead><tr><Th>Created</Th><Th>Supplier</Th><Th>Status</Th><Th>Items</Th>{canAdjust && <Th>Actions</Th>}</tr></thead>
            <tbody>
              {orders.data.map((order) => {
                const canReceive = canAdjust && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status);
                const canCancel = canReceive;
                return (
                  <tr key={order.id}>
                    <Td className="whitespace-nowrap">{fmtDate(order.createdAt)}</Td>
                    <Td>{order.supplierName}{order.notes && <div className="text-xs text-muted-foreground">{order.notes}</div>}</Td>
                    <Td><Badge tone={order.status === 'RECEIVED' ? 'success' : order.status === 'CANCELLED' ? 'danger' : 'warning'}>{order.status.replace('_', ' ')}</Badge></Td>
                    <Td className="min-w-52">
                      {order.lines.map((line) => (
                        <div key={line.id} className="text-sm">{line.itemName}: {line.receivedQuantity} / {line.orderedQuantity} · {formatPaise(line.unitCostPaise)} / unit</div>
                      ))}
                    </Td>
                    {canAdjust && <Td className="space-x-2 whitespace-nowrap">
                      {canReceive && <Button size="sm" variant="outline" onClick={() => { setError(null); setReceiving(order); }}>Receive</Button>}
                      {canCancel && <Button size="sm" variant="ghost" onClick={() => { if (confirm('Cancel the unreceived remainder of this purchase order?')) cancelOrder.mutate(order.id); }}>Cancel</Button>}
                    </Td>}
                  </tr>
                );
              })}
              {!orders.data.length && <tr><Td colSpan={5} className="text-center text-muted-foreground">No purchase orders yet.</Td></tr>}
            </tbody>
          </Table>
        </Card>
      )}
      <Modal open={modal === 'supplier'} title="New supplier" onClose={() => setModal(null)}>
        <SupplierFormView onSubmit={(values) => createSupplier.mutate(values)} pending={createSupplier.isPending} error={error} onCancel={() => setModal(null)} />
      </Modal>
      <Modal open={modal === 'item'} title="New inventory item" onClose={() => setModal(null)}>
        <InventoryFormView onSubmit={(values) => createItem.mutate(values)} pending={createItem.isPending} error={error} onCancel={() => setModal(null)} />
      </Modal>
      <Modal open={modal === 'order'} title="New purchase order" onClose={() => setModal(null)}>
        <PurchaseOrderFormView suppliers={suppliers.data ?? []} items={items.data ?? []} onSubmit={(values) => createOrder.mutate(values)} pending={createOrder.isPending} error={error} onCancel={() => setModal(null)} />
      </Modal>
      <Modal open={receiving !== null} title="Receive purchase order" onClose={() => setReceiving(null)}>
        {receiving && <ReceiveFormView order={receiving} onSubmit={(values) => receive.mutate({ order: receiving, values })} pending={receive.isPending} error={error} onCancel={() => setReceiving(null)} />}
      </Modal>
    </>
  );
}
