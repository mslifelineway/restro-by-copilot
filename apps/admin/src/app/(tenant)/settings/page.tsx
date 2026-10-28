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
import { Card, CardBody } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { api, applyServerErrors } from '@/lib/api';
import type { TenantProfile } from '@/lib/types';
import { useCan } from '@/lib/use-me';

const schema = z.object({
  name: z.string().min(2).max(100),
  timezone: z.string().min(1),
  currency: z.string().length(3),
  language: z.string().min(2),
  dateFormat: z.string().min(1),
});
type Form = z.infer<typeof schema>;

const timezones = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];

export default function SettingsPage() {
  const qc = useQueryClient();
  const canEdit = useCan('tenant:update');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const q = useQuery({ queryKey: ['tenant-profile'], queryFn: () => api.get<TenantProfile>('/v1/tenant') });
  const { register, handleSubmit, reset, setError, formState: { errors, isDirty } } = useForm<Form>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (q.data) reset({ name: q.data.name, timezone: q.data.timezone, currency: q.data.currency, language: q.data.language, dateFormat: q.data.date_format });
  }, [q.data, reset]);

  const save = useMutation({
    mutationFn: (v: Form) => api.patch('/v1/tenant', v),
    onSuccess: () => { setMsg({ ok: true, text: 'Settings saved' }); qc.invalidateQueries({ queryKey: ['tenant-profile'] }); },
    onError: (e) => { const m = applyServerErrors(e, setError); if (m) setMsg({ ok: false, text: m }); },
  });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;

  return (
    <>
      <PageHeader title="Settings" description="Business-wide defaults used for dates, money and language." />
      <Card className="max-w-xl"><CardBody>
        <form onSubmit={handleSubmit((v) => { setMsg(null); save.mutate(v); })} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="sm:col-span-2"><Field label="Business name" error={errors.name?.message}><Input disabled={!canEdit} {...register('name')} /></Field></div>
          <Field label="Time zone" error={errors.timezone?.message} hint="Reports and day-end use this time zone">
            <Input list="tz" disabled={!canEdit} {...register('timezone')} />
            <datalist id="tz">{timezones.map((t) => <option key={t} value={t} />)}</datalist>
          </Field>
          <Field label="Currency" error={errors.currency?.message}>
            <Select className="w-full" disabled={!canEdit} {...register('currency')}>{['INR', 'USD', 'AED', 'GBP', 'EUR', 'SGD'].map((c) => <option key={c}>{c}</option>)}</Select>
          </Field>
          <Field label="Language" error={errors.language?.message}>
            <Select className="w-full" disabled={!canEdit} {...register('language')}><option value="en">English</option><option value="hi">Hindi</option></Select>
          </Field>
          <Field label="Date format" error={errors.dateFormat?.message}>
            <Select className="w-full" disabled={!canEdit} {...register('dateFormat')}>{['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((d) => <option key={d}>{d}</option>)}</Select>
          </Field>
          <div className="sm:col-span-2 space-y-2">
            {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-sm text-success' : 'text-sm text-destructive'}>{msg.text}</p>}
            {canEdit ? <Button type="submit" disabled={!isDirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
              : <p className="text-sm text-muted-foreground">You can view but not change these settings.</p>}
          </div>
        </form>
      </CardBody></Card>
    </>
  );
}
