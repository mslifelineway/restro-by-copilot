'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@rms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError, applyServerErrors } from '@/lib/api';
import { Field } from './field';
import { Button } from './ui/button';
import { Card, CardBody, CardHeader } from './ui/card';
import { Input } from './ui/input';

const schema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`).max(PASSWORD_MAX_LENGTH),
  confirm: z.string(),
}).refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Form = z.infer<typeof schema>;

/** Change-password form for the signed-in user (platform or restaurant). Other sessions are signed out by the API. */
export function ChangePasswordCard() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });

  const change = useMutation({
    mutationFn: (v: Form) => api.post<{ sessionsEnded: number }>('/v1/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword }),
    onSuccess: (r) => {
      reset();
      qc.invalidateQueries({ queryKey: ['sessions'] });
      setMsg({ ok: true, text: r.sessionsEnded ? `Password changed. ${r.sessionsEnded} other session(s) were signed out.` : 'Password changed.' });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'CURRENT_PASSWORD_INCORRECT') { setError('currentPassword', { message: e.message }); return; }
      if (e instanceof ApiError && e.code === 'PASSWORD_UNCHANGED') { setError('newPassword', { message: e.message }); return; }
      const m = applyServerErrors(e, setError as never);
      if (m) setMsg({ ok: false, text: m });
    },
  });

  return (
    <Card className="max-w-xl">
      <CardHeader>Change password</CardHeader>
      <CardBody>
        <form method="post" onSubmit={handleSubmit((v) => { setMsg(null); change.mutate(v); })} className="space-y-3" noValidate>
          <Field label="Current password" error={errors.currentPassword?.message}><Input type="password" autoComplete="current-password" {...register('currentPassword')} /></Field>
          <Field label="New password" error={errors.newPassword?.message} hint={`At least ${PASSWORD_MIN_LENGTH} characters. A long phrase is better than a complex word.`}>
            <Input type="password" autoComplete="new-password" {...register('newPassword')} />
          </Field>
          <Field label="Confirm new password" error={errors.confirm?.message}><Input type="password" autoComplete="new-password" {...register('confirm')} /></Field>
          {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-sm text-success' : 'text-sm text-destructive'}>{msg.text}</p>}
          <Button type="submit" disabled={change.isPending}>{change.isPending ? 'Changing…' : 'Change password'}</Button>
        </form>
      </CardBody>
    </Card>
  );
}
