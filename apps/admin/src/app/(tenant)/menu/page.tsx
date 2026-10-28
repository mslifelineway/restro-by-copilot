'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
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

type Category = { id: string; name: string; sortOrder: number; isActive: boolean };
type TaxSlab = { id: string; code: string; cgstRate: number; sgstRate: number; igstRate: number; effectiveFrom: string };
type MenuItem = {
  id: string; categoryId: string; categoryName: string; taxSlabId: string; taxCode: string;
  name: string; description: string | null; dietaryType: 'VEG' | 'NON_VEG' | 'EGG'; isAvailable: boolean; sku: string | null;
};
type Variant = { id: string; name: string; basePrice: string; isDefault: boolean };
type AddOnGroup = {
  id: string; name: string; minSelection: number; maxSelection: number; isMandatory: boolean;
  addOns: Array<{ id: string; name: string; price: string; isActive: boolean }>;
};
type TaxForm = { code: string; cgstRate: number; sgstRate: number; igstRate: number; effectiveFrom: string };

const categorySchema = z.object({ name: z.string().min(2).max(100), sortOrder: z.coerce.number().int().min(0).max(100000) });
const itemSchema = z.object({
  categoryId: z.string().uuid('Choose a category'), taxSlabId: z.string().uuid('Choose a tax slab'),
  name: z.string().min(2).max(120), description: z.string().max(1000),
  dietaryType: z.enum(['VEG', 'NON_VEG', 'EGG']), sku: z.string().max(80),
});
const variantSchema = z.object({ name: z.string().min(1).max(80), basePrice: z.string().regex(/^(0|[1-9]\d{0,18})$/, 'Enter whole paise'), isDefault: z.boolean() });
const groupSchema = z.object({ name: z.string().min(2).max(100), minSelection: z.coerce.number().int().min(0).max(100), maxSelection: z.coerce.number().int().min(1).max(100) });
const addOnSchema = z.object({ name: z.string().min(1).max(100), price: z.string().regex(/^(0|[1-9]\d{0,18})$/, 'Enter whole paise') });
const taxSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{2,30}$/, 'Use 2–30 uppercase letters, numbers, dash, or underscore'),
  cgstRate: z.coerce.number().int().min(0).max(10000),
  sgstRate: z.coerce.number().int().min(0).max(10000),
  igstRate: z.coerce.number().int().min(0).max(10000),
  effectiveFrom: z.string().date(),
});
type CategoryForm = z.infer<typeof categorySchema>;
type ItemForm = z.infer<typeof itemSchema>;
type VariantForm = z.infer<typeof variantSchema>;
type GroupForm = z.infer<typeof groupSchema>;
type AddOnForm = z.infer<typeof addOnSchema>;

function TaxFormView({ onSubmit, pending, error }: { onSubmit: (value: TaxForm) => void; pending: boolean; error: string | null }) {
  const { register, handleSubmit, formState: { errors } } = useForm<TaxForm>({
    resolver: zodResolver(taxSchema),
    defaultValues: { cgstRate: 0, sgstRate: 0, igstRate: 0, effectiveFrom: new Date().toISOString().slice(0, 10) },
  });
  return <form className="grid gap-3 md:grid-cols-3" onSubmit={handleSubmit(onSubmit)} noValidate>
    <Field label="Tax code" error={errors.code?.message}><Input {...register('code')} placeholder="GST_18" /></Field>
    <Field label="CGST rate (basis points)" error={errors.cgstRate?.message}><Input type="number" min={0} max={10000} {...register('cgstRate')} /></Field>
    <Field label="SGST rate (basis points)" error={errors.sgstRate?.message}><Input type="number" min={0} max={10000} {...register('sgstRate')} /></Field>
    <Field label="IGST rate (basis points)" error={errors.igstRate?.message}><Input type="number" min={0} max={10000} {...register('igstRate')} /></Field>
    <Field label="Effective from" error={errors.effectiveFrom?.message}><Input type="date" {...register('effectiveFrom')} /></Field>
    <div className="self-end"><Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Add tax slab'}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive md:col-span-3">{error}</p>}
  </form>;
}

function CategoryFormView({ onSubmit, pending, error }: { onSubmit: (value: CategoryForm) => void; pending: boolean; error: string | null }) {
  const { register, handleSubmit, formState: { errors } } = useForm<CategoryForm>({ resolver: zodResolver(categorySchema), defaultValues: { sortOrder: 0 } });
  return <form className="grid gap-3 md:grid-cols-[1fr_150px_auto]" onSubmit={handleSubmit(onSubmit)} noValidate>
    <Field label="Category name" error={errors.name?.message}><Input {...register('name')} /></Field>
    <Field label="Sort order" error={errors.sortOrder?.message}><Input type="number" min={0} {...register('sortOrder')} /></Field>
    <div className="self-end"><Button type="submit" disabled={pending}>Add category</Button></div>
    {error && <p role="alert" className="text-sm text-destructive md:col-span-3">{error}</p>}
  </form>;
}

function ItemFormView({ categories, taxes, onSubmit, pending, error, initial }: {
  categories: Category[]; taxes: TaxSlab[]; onSubmit: (value: ItemForm) => void; pending: boolean; error: string | null; initial?: MenuItem;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<ItemForm>({
    resolver: zodResolver(itemSchema),
    defaultValues: initial
      ? { categoryId: initial.categoryId, taxSlabId: initial.taxSlabId, name: initial.name, description: initial.description ?? '', dietaryType: initial.dietaryType, sku: initial.sku ?? '' }
      : { dietaryType: 'VEG', description: '', sku: '' },
  });
  return <form className="grid gap-3 md:grid-cols-2" onSubmit={handleSubmit(onSubmit)} noValidate>
    <Field label="Item name" error={errors.name?.message}><Input {...register('name')} /></Field>
    <Field label="Category" error={errors.categoryId?.message}><Select {...register('categoryId')}><option value="">Choose category</option>{categories.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field>
    <Field label="GST slab" error={errors.taxSlabId?.message}><Select {...register('taxSlabId')}><option value="">Choose tax slab</option>{taxes.map((row) => <option key={row.id} value={row.id}>{row.code} · GST {((row.cgstRate + row.sgstRate) / 100).toFixed(2)}%</option>)}</Select></Field>
    <Field label="Dietary type" error={errors.dietaryType?.message}><Select {...register('dietaryType')}><option value="VEG">Vegetarian</option><option value="NON_VEG">Non-vegetarian</option><option value="EGG">Egg</option></Select></Field>
    <Field label="SKU (optional)" error={errors.sku?.message}><Input {...register('sku')} /></Field>
    <Field label="Description (optional)" error={errors.description?.message}><Input {...register('description')} /></Field>
    {error && <p role="alert" className="text-sm text-destructive md:col-span-2">{error}</p>}
    <div><Button type="submit" disabled={pending || !categories.length || !taxes.length}>{pending ? 'Saving…' : initial ? 'Update menu item' : 'Add menu item'}</Button></div>
  </form>;
}

function VariantFormView({ onSubmit, pending, error, initial }: { onSubmit: (value: VariantForm) => void; pending: boolean; error: string | null; initial?: Variant }) {
  const { register, handleSubmit, formState: { errors } } = useForm<VariantForm>({
    resolver: zodResolver(variantSchema),
    defaultValues: initial
      ? { name: initial.name, basePrice: initial.basePrice, isDefault: initial.isDefault }
      : { isDefault: true },
  });
  return <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={handleSubmit(onSubmit)} noValidate>
    <Field label="Variant name" error={errors.name?.message}><Input placeholder="Regular / Half / Full" {...register('name')} /></Field>
    <Field label="Base price (paise)" error={errors.basePrice?.message}><Input inputMode="numeric" {...register('basePrice')} /></Field>
    <div className="self-end"><Button type="submit" disabled={pending}>{pending ? 'Saving…' : initial ? 'Update variant' : 'Add variant'}</Button></div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...register('isDefault')} /> Default variant</label>
    {error && <p role="alert" className="text-sm text-destructive md:col-span-3">{error}</p>}
  </form>;
}

export default function MenuPage() {
  const qc = useQueryClient();
  const me = useMe();
  const canRead = useCan('menu:read');
  const canEdit = useCan('menu:edit');
  const canEditPrice = useCan('menu:edit_price');
  const canSelectOutlet = useCan('outlet:read');
  const [outletId, setOutletId] = useState('');
  const [selectedItem, setSelectedItem] = useState('');
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
  const [editingVariant, setEditingVariant] = useState<Variant | null>(null);
  const [csv, setCsv] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');

  const outlets = useQuery({ queryKey: ['outlets', 'all'], queryFn: () => api.list<Outlet>('/v1/outlets?page=1&limit=100'), enabled: canSelectOutlet });
  useEffect(() => {
    if (outletId) return;
    if (me.data?.kind === 'tenant' && me.data.outletId) setOutletId(me.data.outletId);
    else if (outlets.data?.items[0]) setOutletId(outlets.data.items[0].id);
  }, [outletId, me.data, outlets.data]);

  const headers = { 'x-outlet-id': outletId };
  const categories = useQuery({ queryKey: ['menu-categories', outletId], queryFn: () => api.list<Category>('/v1/menu/categories?page=1&limit=100', headers), enabled: !!outletId && canRead });
  const taxes = useQuery({ queryKey: ['tax-slabs'], queryFn: () => api.list<TaxSlab>('/v1/tax-slabs?page=1&limit=100'), enabled: canRead });
  const items = useQuery({ queryKey: ['menu-items', outletId], queryFn: () => api.list<MenuItem>('/v1/menu/items?page=1&limit=100', headers), enabled: !!outletId && canRead });
  const groups = useQuery({ queryKey: ['menu-add-on-groups'], queryFn: () => api.get<AddOnGroup[]>('/v1/menu/add-on-groups'), enabled: canRead });
  const variants = useQuery({ queryKey: ['menu-variants', selectedItem, outletId], queryFn: () => api.get<Variant[]>(`/v1/menu/items/${selectedItem}/variants`, headers), enabled: !!selectedItem && canRead });
  const assignedGroups = useQuery({ queryKey: ['menu-item-groups', selectedItem, outletId], queryFn: () => api.get<Array<{ id: string }>>(`/v1/menu/items/${selectedItem}/add-on-groups`, headers), enabled: !!selectedItem && canRead });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['menu-categories', outletId] });
    void qc.invalidateQueries({ queryKey: ['menu-items', outletId] });
    void qc.invalidateQueries({ queryKey: ['menu-variants', selectedItem, outletId] });
    void qc.invalidateQueries({ queryKey: ['menu-item-groups', selectedItem, outletId] });
    void qc.invalidateQueries({ queryKey: ['menu-add-on-groups'] });
  };
  const handleError = (reason: unknown, fallback: string) => setError(reason instanceof ApiError ? reason.message : fallback);

  const createCategory = useMutation({
    mutationFn: (value: CategoryForm) => api.post('/v1/menu/categories', value, headers),
    onSuccess: () => { setError(null); setNotice('Category created.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to create category'),
  });
  const createTax = useMutation({
    mutationFn: (value: TaxForm) => api.post('/v1/tax-slabs', value),
    onSuccess: () => { setError(null); setNotice('Tax slab created.'); void qc.invalidateQueries({ queryKey: ['tax-slabs'] }); },
    onError: (reason) => handleError(reason, 'Unable to create tax slab'),
  });
  const toggleCategory = useMutation({
    mutationFn: (category: Category) => api.patch(`/v1/menu/categories/${category.id}`, { isActive: !category.isActive }, headers),
    onSuccess: () => { setError(null); setNotice('Category status updated.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to update category'),
  });
  const createItem = useMutation({
    mutationFn: (value: ItemForm) => api.post<MenuItem>('/v1/menu/items', { ...value, sku: value.sku || undefined, description: value.description || undefined }, headers),
    onSuccess: (item) => { setError(null); setNotice('Menu item created. Add one or more variants to make it orderable.'); setSelectedItem(item.id); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to create menu item'),
  });
  const updateItem = useMutation({
    mutationFn: ({ id, value }: { id: string; value: ItemForm }) => api.patch(`/v1/menu/items/${id}`, {
      ...value, sku: value.sku || undefined, description: value.description || undefined,
    }, headers),
    onSuccess: () => { setEditingItem(null); setError(null); setNotice('Menu item updated.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to update menu item'),
  });
  const toggleItem = useMutation({
    mutationFn: (item: MenuItem) => api.patch(`/v1/menu/items/${item.id}`, { isAvailable: !item.isAvailable }, headers),
    onSuccess: () => { setError(null); setNotice('Menu availability updated.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to update menu availability'),
  });
  const createVariant = useMutation({
    mutationFn: (value: VariantForm) => api.post(`/v1/menu/items/${selectedItem}/variants`, value, headers),
    onSuccess: () => { setError(null); setNotice('Variant created.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to create variant'),
  });
  const updateVariant = useMutation({
    mutationFn: ({ id, value }: { id: string; value: VariantForm }) => api.patch(`/v1/menu/variants/${id}`, value, headers),
    onSuccess: () => { setEditingVariant(null); setError(null); setNotice('Variant updated.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to update variant'),
  });
  const createGroup = useMutation({
    mutationFn: (value: GroupForm) => api.post<AddOnGroup>('/v1/menu/add-on-groups', { ...value, isMandatory: value.minSelection > 0 }, headers),
    onSuccess: () => { setError(null); setNotice('Modifier group created.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to create modifier group'),
  });
  const addOn = useMutation({
    mutationFn: ({ id, value }: { id: string; value: AddOnForm }) => api.post(`/v1/menu/add-on-groups/${id}/add-ons`, value, headers),
    onSuccess: () => { setError(null); setNotice('Modifier option added.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to add modifier'),
  });
  const assignGroup = useMutation({
    mutationFn: (ids: string[]) => api.put(`/v1/menu/items/${selectedItem}/add-on-groups`, { groupIds: ids }, headers),
    onSuccess: () => { setError(null); setNotice('Modifier groups updated for this menu item.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to assign modifier group'),
  });
  const importCsv = useMutation({
    mutationFn: () => api.post('/v1/menu/import', { csv }, headers),
    onSuccess: () => { setCsv(''); setError(null); setNotice('Menu CSV imported successfully.'); refresh(); },
    onError: (reason) => handleError(reason, 'Unable to import menu CSV'),
  });
  const exportCsv = useMutation({
    mutationFn: () => api.get<string>('/v1/menu/export', headers),
    onSuccess: (value) => {
      const url = URL.createObjectURL(new Blob([value], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'menu.csv';
      anchor.click();
      URL.revokeObjectURL(url);
    },
    onError: (reason) => handleError(reason, 'Unable to export menu CSV'),
  });

  const categoryRows = categories.data?.items ?? [];
  const itemRows = items.data?.items ?? [];
  const groupRows = groups.data ?? [];
  const currentItemGroups = new Set((assignedGroups.data ?? []).map((group) => group.id));
  const itemFormError = editingItem
    ? updateItem.error instanceof ApiError ? updateItem.error.message : null
    : createItem.error instanceof ApiError ? createItem.error.message : null;
  const variantFormError = editingVariant
    ? updateVariant.error instanceof ApiError ? updateVariant.error.message : null
    : createVariant.error instanceof ApiError ? createVariant.error.message : null;
  const loading = me.isLoading || (canSelectOutlet && outlets.isLoading) || (canRead && (!!outletId && (categories.isLoading || items.isLoading)) || taxes.isLoading || groups.isLoading);
  if (loading) return <Loading />;
  if (me.isError) return <ErrorBox error={me.error} />;
  if (canSelectOutlet && outlets.isError) return <ErrorBox error={outlets.error} />;
  if (categories.isError) return <ErrorBox error={categories.error} />;
  if (items.isError) return <ErrorBox error={items.error} />;
  if (taxes.isError) return <ErrorBox error={taxes.error} />;
  if (groups.isError) return <ErrorBox error={groups.error} />;

  return <div>
    <PageHeader title="Menu" description="Manage outlet categories, menu items, variants, modifiers, tax mapping, and CSV exchange." />
    {notice && <p role="status" className="mb-3 text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    {canSelectOutlet && outlets.data && <div className="mb-4 max-w-sm"><Field label="Outlet"><Select value={outletId} onChange={(event) => { setOutletId(event.target.value); setSelectedItem(''); setEditingItem(null); }}><option value="">Choose outlet</option>{outlets.data.items.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</Select></Field></div>}

    {canEdit && <Card className="mb-5 space-y-4 p-4"><h2 className="text-lg font-semibold">Categories</h2>
      <CategoryFormView onSubmit={(value) => createCategory.mutate(value)} pending={createCategory.isPending} error={createCategory.error instanceof ApiError ? createCategory.error.message : null} />
      <div className="flex flex-wrap gap-2">{categoryRows.map((row) => <span key={row.id} className="flex items-center gap-2 rounded border px-3 py-1 text-sm">{row.name}{!row.isActive ? ' · inactive' : ''}<Button size="sm" variant="outline" onClick={() => toggleCategory.mutate(row)} disabled={toggleCategory.isPending}>{row.isActive ? 'Deactivate' : 'Activate'}</Button></span>)}</div>
    </Card>}

    {canEdit && <Card className="mb-5 space-y-4 p-4"><h2 className="text-lg font-semibold">GST tax slabs</h2>
      <p className="text-sm text-muted-foreground">Rates are basis points: 900 CGST + 900 SGST represents 18% GST.</p>
      <TaxFormView onSubmit={(value) => createTax.mutate(value)} pending={createTax.isPending} error={createTax.error instanceof ApiError ? createTax.error.message : null} />
      <div className="flex flex-wrap gap-2">{(taxes.data?.items ?? []).map((tax) => <span key={tax.id} className="rounded border px-3 py-1 text-sm">{tax.code} · GST {(Math.max(tax.cgstRate + tax.sgstRate, tax.igstRate) / 100).toFixed(2)}%</span>)}</div>
    </Card>}

    {canEdit && <Card className="mb-5 space-y-4 p-4"><h2 className="text-lg font-semibold">{editingItem ? `Edit ${editingItem.name}` : 'Add menu item'}</h2>
      {!categoryRows.length || !taxes.data?.items.length ? <p className="text-sm text-muted-foreground">Create a category and tax slab before adding menu items.</p> :
        <ItemFormView key={editingItem?.id ?? 'new'} initial={editingItem ?? undefined} categories={categoryRows.filter((row) => row.isActive)} taxes={taxes.data.items} onSubmit={(value) => editingItem ? updateItem.mutate({ id: editingItem.id, value }) : createItem.mutate(value)} pending={createItem.isPending || updateItem.isPending} error={itemFormError} />}
    </Card>}

    <Card className="mb-5 p-4"><h2 className="mb-3 text-lg font-semibold">Menu items</h2>
      <Table><thead><tr><Th>Item</Th><Th>Category</Th><Th>Dietary</Th><Th>Tax slab</Th><Th>Availability</Th><Th>Variants</Th></tr></thead>
        <tbody>{itemRows.map((item) => <tr key={item.id} className={selectedItem === item.id ? 'bg-muted/50' : ''}>
          <Td><button className="font-medium underline-offset-2 hover:underline" onClick={() => { setSelectedItem(item.id); setEditingVariant(null); }}>{item.name}</button>{item.sku && <div className="text-xs text-muted-foreground">{item.sku}</div>}{canEdit && <Button size="sm" variant="outline" className="mt-1" onClick={() => setEditingItem(item)}>Edit</Button>}</Td>
          <Td>{item.categoryName}</Td><Td>{item.dietaryType.replace('_', ' ')}</Td><Td>{item.taxCode}</Td>
          <Td>{item.isAvailable ? 'Available' : 'Off'} {canEdit && <Button size="sm" variant="outline" className="ml-2" onClick={() => toggleItem.mutate(item)} disabled={toggleItem.isPending}>{item.isAvailable ? 'Turn off' : 'Turn on'}</Button>}</Td>
          <Td><Button size="sm" variant="outline" onClick={() => setSelectedItem(item.id)}>Manage</Button></Td>
        </tr>)}
        {!itemRows.length && <tr><Td colSpan={6} className="text-center text-muted-foreground">No menu items configured for this outlet.</Td></tr>}</tbody>
      </Table>
      {items.data && items.data.pagination.totalItems > itemRows.length && <p className="mt-3 text-sm text-muted-foreground">Showing the first {itemRows.length} items.</p>}
    </Card>

    {selectedItem && <Card className="mb-5 space-y-4 p-4"><h2 className="text-lg font-semibold">Variants and modifiers</h2>
      <p className="text-sm text-muted-foreground">{itemRows.find((row) => row.id === selectedItem)?.name ?? selectedItem}</p>
      <Table><thead><tr><Th>Name</Th><Th>Base price (paise)</Th><Th>Default</Th><Th>Actions</Th></tr></thead><tbody>{(variants.data ?? []).map((row) => <tr key={row.id}><Td>{row.name}</Td><Td>{row.basePrice}</Td><Td>{row.isDefault ? 'Yes' : 'No'}</Td><Td>{canEditPrice && <Button size="sm" variant="outline" onClick={() => setEditingVariant(row)}>Edit</Button>}</Td></tr>)}{variants.data?.length === 0 && <tr><Td colSpan={4}>No variants yet; this item cannot be ordered.</Td></tr>}</tbody></Table>
      {canEditPrice && <VariantFormView key={editingVariant?.id ?? 'new'} initial={editingVariant ?? undefined} onSubmit={(value) => editingVariant ? updateVariant.mutate({ id: editingVariant.id, value }) : createVariant.mutate(value)} pending={createVariant.isPending || updateVariant.isPending} error={variantFormError} />}
      {!!groupRows.length && <div className="space-y-2"><h3 className="font-medium">Modifier groups assigned to this item</h3>
        {groupRows.map((group) => <label key={group.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={currentItemGroups.has(group.id)} onChange={(event) => {
          const next = new Set(currentItemGroups);
          if (event.target.checked) next.add(group.id); else next.delete(group.id);
          assignGroup.mutate([...next]);
        }} disabled={!canEdit || assignGroup.isPending} />{group.name} ({group.minSelection}–{group.maxSelection}){group.addOns.length ? ` · ${group.addOns.map((row) => row.name).join(', ')}` : ' · no options yet'}</label>)}
      </div>}
    </Card>}

    {canEdit && <Card className="mb-5 space-y-4 p-4"><h2 className="text-lg font-semibold">Modifier groups</h2>
      <GroupCreateSection onCreate={(value) => createGroup.mutate(value)} pending={createGroup.isPending} error={createGroup.error instanceof ApiError ? createGroup.error.message : null} />
      {groupRows.map((group) => <AddOnSection key={group.id} group={group} onAdd={(value) => addOn.mutate({ id: group.id, value })} pending={addOn.isPending} error={addOn.error instanceof ApiError ? addOn.error.message : null} />)}
    </Card>}

    {canEdit && <Card className="space-y-4 p-4"><h2 className="text-lg font-semibold">Menu CSV</h2><p className="text-sm text-muted-foreground">Imports merge by item ID or SKU; omitted rows are not deleted. Prices are integer paise.</p>
      <textarea className="min-h-36 w-full rounded-md border bg-card p-3 font-mono text-sm" aria-label="Menu CSV content" value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="Paste menu CSV for import" />
      <div className="flex gap-2"><Button onClick={() => importCsv.mutate()} disabled={importCsv.isPending || !csv.trim()}>{importCsv.isPending ? 'Importing…' : 'Import CSV'}</Button><Button variant="outline" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending}>{exportCsv.isPending ? 'Exporting…' : 'Export CSV'}</Button></div>
    </Card>}
  </div>;
}

function GroupCreateSection({ onCreate, pending, error }: { onCreate: (value: GroupForm) => void; pending: boolean; error: string | null }) {
  const { register, handleSubmit, formState: { errors } } = useForm<GroupForm>({ resolver: zodResolver(groupSchema), defaultValues: { minSelection: 0, maxSelection: 1 } });
  return <form className="grid gap-3 md:grid-cols-[1fr_150px_150px_auto]" onSubmit={handleSubmit(onCreate)} noValidate>
    <Field label="Group name" error={errors.name?.message}><Input {...register('name')} /></Field>
    <Field label="Minimum choices" error={errors.minSelection?.message}><Input type="number" min={0} {...register('minSelection')} /></Field>
    <Field label="Maximum choices" error={errors.maxSelection?.message}><Input type="number" min={1} {...register('maxSelection')} /></Field>
    <div className="self-end"><Button type="submit" disabled={pending}>Add group</Button></div>
    {error && <p role="alert" className="text-sm text-destructive md:col-span-4">{error}</p>}
  </form>;
}

function AddOnSection({ group, onAdd, pending, error }: {
  group: AddOnGroup; onAdd: (value: AddOnForm) => void; pending: boolean; error: string | null;
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<AddOnForm>({ resolver: zodResolver(addOnSchema) });
  return <div className="rounded-md border p-3"><h3 className="mb-2 font-medium">{group.name}</h3>
    <p className="mb-2 text-sm text-muted-foreground">Select {group.minSelection} to {group.maxSelection}; {group.isMandatory ? 'required' : 'optional'}.</p>
    <ul className="mb-3 flex flex-wrap gap-2 text-sm">{group.addOns.map((row) => <li key={row.id} className="rounded bg-muted px-2 py-1">{row.name} · {row.price} paise {row.isActive ? '' : '· inactive'}</li>)}</ul>
    <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto]" onSubmit={handleSubmit(onAdd)} noValidate>
      <Field label="Modifier option" error={errors.name?.message}><Input {...register('name')} /></Field>
      <Field label="Price (paise)" error={errors.price?.message}><Input inputMode="numeric" {...register('price')} /></Field>
      <div className="self-end"><Button type="submit" size="sm" variant="outline" disabled={pending}>Add option</Button></div>
      {error && <p role="alert" className="text-sm text-destructive md:col-span-3">{error}</p>}
    </form>
  </div>;
}
