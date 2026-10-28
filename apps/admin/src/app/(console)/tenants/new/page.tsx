'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api, applyServerErrors } from '@/lib/api';

const schema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Lowercase letters, digits and hyphens (3-50 chars)'),
  planCode: z.enum(['trial', 'starter', 'growth', 'enterprise']),
  outletName: z.string().optional(),
  ownerName: z.string().min(2).max(100),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(10, 'At least 10 characters'),
});
type Form = z.infer<typeof schema>;

const Field = ({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) => (
  <label className="block space-y-1 text-sm"><span>{label}</span>{children}{error && <span role="alert" className="block text-xs text-destructive">{error}</span>}</label>
);

export default function NewTenantPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { planCode: 'trial' } });

  const create = useMutation({
    mutationFn: (v: Form) => api.post<{ id: string }>('/v1/platform/tenants', v),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ['tenants'] }); router.push(`/tenants/${t.id}`); },
    onError: (e) => setFormError(applyServerErrors(e, setError)),
  });

  return (
    <>
      <PageHeader title="New tenant" description="Creates the tenant, subscription, first outlet, system roles and the owner account." />
      <Card className="max-w-2xl">
        <CardBody>
          <form onSubmit={handleSubmit((v) => { setFormError(null); create.mutate(v); })} className="grid gap-4 sm:grid-cols-2" noValidate>
            <Field label="Brand name" error={errors.name?.message}><Input {...register('name')} /></Field>
            <Field label="Slug (used at login)" error={errors.slug?.message}><Input {...register('slug')} /></Field>
            <Field label="Plan" error={errors.planCode?.message}>
              <Select className="w-full" {...register('planCode')}>
                {['trial', 'starter', 'growth', 'enterprise'].map((p) => <option key={p}>{p}</option>)}
              </Select>
            </Field>
            <Field label="First outlet name (optional)" error={errors.outletName?.message}><Input {...register('outletName')} /></Field>
            <Field label="Owner name" error={errors.ownerName?.message}><Input {...register('ownerName')} /></Field>
            <Field label="Owner email" error={errors.ownerEmail?.message}><Input type="email" {...register('ownerEmail')} /></Field>
            <Field label="Owner password" error={errors.ownerPassword?.message}><Input type="password" autoComplete="new-password" {...register('ownerPassword')} /></Field>
            <div className="sm:col-span-2">
              {formError && <p role="alert" className="mb-2 text-sm text-destructive">{formError}</p>}
              <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create tenant'}</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </>
  );
}
