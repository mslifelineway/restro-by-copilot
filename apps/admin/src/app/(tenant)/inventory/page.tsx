'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { PageHeader } from '@/components/page-header';
import { ErrorBox, Loading } from '@/components/query-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import type { Outlet } from '@/lib/types';
import { useCan, useMe } from '@/lib/use-me';

type InventoryItem = { id: string; name: string; baseUnit: string; reorderLevel: string; onHand: string };
type MenuItem = { id: string; name: string };
const quantity = z.string().regex(/^(?:0*[1-9]\d{0,14}(?:\.\d{1,3})?|0*\.\d{1,3})$/, 'Enter a quantity greater than zero with up to 3 decimals');
const movementSchema = z.object({
  inventoryItemId: z.string().uuid('Choose an inventory item'),
  direction: z.enum(['IN', 'OUT']),
  quantity,
  reason: z.enum(['RECEIPT', 'ADJUSTMENT', 'WASTE', 'CONSUMPTION', 'RETURN']),
  reference: z.string().max(100),
}).superRefine(({ direction, reason }, ctx) => {
  if ((direction === 'IN' && ['WASTE', 'CONSUMPTION'].includes(reason)) || (direction === 'OUT' && ['RECEIPT', 'RETURN'].includes(reason))) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Select a reason that matches the stock direction' });
  }
});
const recipeSchema = z.object({
  menuItemId: z.string().uuid('Choose a menu item'),
  ingredients: z.array(z.object({ inventoryItemId: z.string().uuid('Choose an ingredient'), quantity })),
}).superRefine(({ ingredients }, ctx) => {
  const ids = ingredients.map((row) => row.inventoryItemId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['ingredients'], message: 'An ingredient can only be listed once' });
});
type MovementForm = z.infer<typeof movementSchema>;
type RecipeForm = z.infer<typeof recipeSchema>;

function StockMovementForm({ items, onSubmit, pending, error }: {
  items: InventoryItem[]; onSubmit: (form: MovementForm) => void; pending: boolean; error: string | null;
}) {
  const { register, handleSubmit, watch, formState: { errors } } = useForm<MovementForm>({
    resolver: zodResolver(movementSchema),
    defaultValues: { direction: 'IN', reason: 'ADJUSTMENT', quantity: '', reference: '' },
  });
  const direction = watch('direction');
  const reasons = direction === 'IN' ? ['RECEIPT', 'ADJUSTMENT', 'RETURN'] : ['ADJUSTMENT', 'WASTE', 'CONSUMPTION'];
  return <form className="grid gap-3 md:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
    <Field label="Inventory item" error={errors.inventoryItemId?.message}><Select {...register('inventoryItemId')}><option value="">Choose item</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.baseUnit})</option>)}</Select></Field>
    <Field label="Direction" error={errors.direction?.message}><Select {...register('direction')}><option value="IN">Stock in</option><option value="OUT">Stock out</option></Select></Field>
    <Field label="Quantity" error={errors.quantity?.message}><Input inputMode="decimal" {...register('quantity')} /></Field>
    <Field label="Reason" error={errors.reason?.message}><Select {...register('reason')}>{reasons.map((reason) => <option key={reason} value={reason}>{reason.toLowerCase().replace('_', ' ')}</option>)}</Select></Field>
    <Field label="Reference (optional)" error={errors.reference?.message}><Input maxLength={100} {...register('reference')} /></Field>
    <div className="self-end"><Button type="submit" disabled={pending || !items.length}>{pending ? 'Recording…' : 'Record movement'}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive md:col-span-2">{error}</p>}
  </form>;
}

function RecipeEditor({ items, menuItems, headers, onSubmit, pending, error }: {
  items: InventoryItem[]; menuItems: MenuItem[]; headers: HeadersInit; onSubmit: (form: RecipeForm) => void; pending: boolean; error: string | null;
}) {
  const { register, control, handleSubmit, watch, reset, formState: { errors } } = useForm<RecipeForm>({
    resolver: zodResolver(recipeSchema), defaultValues: { menuItemId: '', ingredients: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'ingredients' });
  const menuItemId = watch('menuItemId');
  const recipe = useQuery({
    queryKey: ['inventory-recipe', menuItemId],
    queryFn: () => api.get<Array<{ inventoryItemId: string; quantity: string }>>(`/v1/inventory/recipes/${menuItemId}`, headers),
    enabled: !!menuItemId,
  });
  useEffect(() => {
    if (menuItemId && recipe.data) reset({ menuItemId, ingredients: recipe.data });
  }, [menuItemId, recipe.data, reset]);
  return <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
    <Field label="Menu item" error={errors.menuItemId?.message}><Select {...register('menuItemId')}><option value="">Choose menu item</option>{menuItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
    {recipe.isLoading && menuItemId && <p className="text-sm text-muted-foreground">Loading saved recipe…</p>}
    {recipe.isError && <p role="alert" className="text-sm text-destructive">{recipe.error instanceof ApiError ? recipe.error.message : 'Unable to load recipe'}</p>}
    {menuItemId && <div className="space-y-3">
      {fields.map((field, index) => <div key={field.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Field label={`Ingredient ${index + 1}`} error={errors.ingredients?.[index]?.inventoryItemId?.message}><Select {...register(`ingredients.${index}.inventoryItemId`)}><option value="">Choose ingredient</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.baseUnit})</option>)}</Select></Field>
        <Field label="Quantity per menu item" error={errors.ingredients?.[index]?.quantity?.message}><Input inputMode="decimal" {...register(`ingredients.${index}.quantity`)} /></Field>
        <Button type="button" className="self-end" variant="outline" onClick={() => remove(index)}>Remove</Button>
      </div>)}
      {errors.ingredients?.message && <p role="alert" className="text-sm text-destructive">{errors.ingredients.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => append({ inventoryItemId: '', quantity: '' })} disabled={!items.length}>Add ingredient</Button>
        <Button type="submit" disabled={pending || recipe.isLoading}>{pending ? 'Saving…' : 'Save recipe'}</Button>
      </div>
      <p className="text-xs text-muted-foreground">A recipe with no ingredients is allowed; stock will not be consumed for that menu item.</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}

export default function InventoryPage() {
  const qc = useQueryClient();
  const me = useMe();
  const canRead = useCan('inventory:read');
  const canAdjust = useCan('inventory:adjust');
  const canMenuRead = useCan('menu:read');
  const canSelectOutlet = useCan('outlet:read');
  const [outletId, setOutletId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const outlets = useQuery({ queryKey: ['outlets', 'all'], queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100'), enabled: canSelectOutlet });
  useEffect(() => {
    if (outletId) return;
    if (me.data?.kind === 'tenant' && me.data.outletId) setOutletId(me.data.outletId);
    else if (outlets.data?.items[0]) setOutletId(outlets.data.items[0].id);
  }, [outletId, me.data, outlets.data]);
  const headers = { 'x-outlet-id': outletId };
  const items = useQuery({ queryKey: ['inventory-items', outletId], queryFn: () => api.get<InventoryItem[]>('/v1/inventory/items', headers), enabled: !!outletId && canRead });
  const menuItems = useQuery({ queryKey: ['menu-items', outletId], queryFn: () => api.list<MenuItem>('/v1/menu/items?page=1&limit=100', headers), enabled: !!outletId && canMenuRead });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inventory-items', outletId] });
    void qc.invalidateQueries({ queryKey: ['inventory-recipe'] });
  };
  const movement = useMutation({
    mutationFn: (form: MovementForm) => api.post(`/v1/inventory/items/${form.inventoryItemId}/movements`, {
      direction: form.direction, quantity: form.quantity, reason: form.reason, reference: form.reference || undefined,
    }, headers),
    onSuccess: () => { setError(null); setNotice('Stock movement recorded.'); refresh(); },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : 'Unable to record stock movement'),
  });
  const recipe = useMutation({
    mutationFn: (form: RecipeForm) => api.put(`/v1/inventory/recipes/${form.menuItemId}`, { ingredients: form.ingredients }, headers),
    onSuccess: () => { setError(null); setNotice('Recipe saved.'); refresh(); },
    onError: (reason) => setError(reason instanceof ApiError ? reason.message : 'Unable to save recipe'),
  });
  if (me.isLoading || (canSelectOutlet && outlets.isLoading) || (canRead && !!outletId && items.isLoading) || (canMenuRead && !!outletId && menuItems.isLoading)) return <Loading />;
  if (me.isError) return <ErrorBox error={me.error} />;
  if (outlets.isError) return <ErrorBox error={outlets.error} />;
  if (items.isError) return <ErrorBox error={items.error} />;
  if (menuItems.isError) return <ErrorBox error={menuItems.error} />;
  const allItems = items.data ?? [];
  return <div>
    <PageHeader title="Inventory" description="Track stock movements, low-stock levels, and menu recipes." />
    {notice && <p role="status" className="mb-3 text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {canSelectOutlet && outlets.data && <div className="mb-4 max-w-sm"><Field label="Outlet"><Select value={outletId} onChange={(event) => setOutletId(event.target.value)}><option value="">Choose outlet</option>{outlets.data.items.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field></div>}
    <Card className="mb-6 space-y-4 p-4">
      <h2 className="text-lg font-semibold">On-hand stock</h2>
      {allItems.length ? <Table><thead><tr><Th>Item</Th><Th>On hand</Th><Th>Reorder level</Th><Th>Status</Th></tr></thead><tbody>
        {allItems.map((item) => {
          const low = Number(item.onHand) <= Number(item.reorderLevel);
          return <tr key={item.id}><Td>{item.name}</Td><Td>{item.onHand} {item.baseUnit}</Td><Td>{item.reorderLevel} {item.baseUnit}</Td><Td>{low ? <span className="font-medium text-destructive">Low stock</span> : 'In stock'}</Td></tr>;
        })}
      </tbody></Table> : <p className="text-sm text-muted-foreground">Create inventory items in Inventory & purchasing before recording stock.</p>}
    </Card>
    {canAdjust && <Card className="mb-6 space-y-4 p-4"><h2 className="text-lg font-semibold">Record stock in, out, or wastage</h2><p className="text-sm text-muted-foreground">Use stock-in with reason Adjustment to record opening balances, or Receipt for goods received.</p>
      <StockMovementForm items={allItems} onSubmit={(form) => movement.mutate(form)} pending={movement.isPending} error={movement.error instanceof ApiError ? movement.error.message : null} />
    </Card>}
    {canAdjust && canMenuRead && <Card className="space-y-4 p-4"><h2 className="text-lg font-semibold">Menu recipes</h2>
      <RecipeEditor items={allItems} menuItems={menuItems.data?.items ?? []} headers={headers} onSubmit={(form) => recipe.mutate(form)} pending={recipe.isPending} error={recipe.error instanceof ApiError ? recipe.error.message : null} />
    </Card>}
  </div>;
}
