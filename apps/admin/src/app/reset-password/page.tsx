'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@rms/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const schema = z.object({
  newPassword: z.string().min(PASSWORD_MIN_LENGTH, `At least ${PASSWORD_MIN_LENGTH} characters`).max(PASSWORD_MAX_LENGTH),
  confirm: z.string(),
}).refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Form = z.infer<typeof schema>;

function ResetPasswordForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{ text: string; expired: boolean } | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    const res = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, newPassword: v.newPassword }) });
    if (res.ok) { setDone(true); return; }
    const body = await res.json().catch(() => null);
    setError({
      text: res.status === 429 ? 'Too many attempts. Please wait a minute and try again.' : body?.error?.message ?? 'Something went wrong',
      expired: body?.error?.code === 'RESET_TOKEN_INVALID',
    });
  });

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm">
        <CardBody>
          <h1 className="text-lg font-semibold">Choose a new password</h1>
          {done ? (
            <div role="status" className="mt-4 space-y-3 text-sm">
              <p>Your password has been updated and you were signed out everywhere.</p>
              <Link className="text-primary hover:underline" href="/login">Sign in with your new password</Link>
            </div>
          ) : !token ? (
            <p role="alert" className="mt-4 text-sm text-destructive">This link is incomplete. <Link className="underline" href="/forgot-password">Request a new one</Link>.</p>
          ) : (
            <form method="post" onSubmit={onSubmit} className="mt-4 space-y-3" noValidate>
              <Field label="New password" error={errors.newPassword?.message} hint={`At least ${PASSWORD_MIN_LENGTH} characters`}><Input type="password" autoComplete="new-password" {...register('newPassword')} /></Field>
              <Field label="Confirm new password" error={errors.confirm?.message}><Input type="password" autoComplete="new-password" {...register('confirm')} /></Field>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error.text} {error.expired && <Link className="underline" href="/forgot-password">Request a new link</Link>}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={isSubmitting}>{isSubmitting ? 'Saving…' : 'Set new password'}</Button>
            </form>
          )}
        </CardBody>
      </Card>
    </main>
  );
}

export default function ResetPasswordPage() {
  return <Suspense><ResetPasswordForm /></Suspense>;
}
