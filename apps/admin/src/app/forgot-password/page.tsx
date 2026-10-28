'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const schemas = {
  tenant: z.object({ tenantSlug: z.string().min(3, 'Restaurant ID is required'), email: z.string().email('Enter a valid email') }),
  platform: z.object({ email: z.string().email('Enter a valid email') }),
};
type Mode = keyof typeof schemas;
type Form = { tenantSlug?: string; email: string };

function ForgotPasswordForm() {
  const initial: Mode = useSearchParams().get('as') === 'platform' ? 'platform' : 'tenant';
  const [mode, setMode] = useState<Mode>(initial);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<Form>({
    resolver: (values, ctx, opts) => zodResolver(schemas[mode])(values, ctx, opts as never) as never,
  });

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    const res = await fetch('/api/auth/forgot-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mode === 'tenant' ? v : { email: v.email }) });
    if (res.ok) { setSent(true); return; }
    setError(res.status === 429 ? 'Too many requests. Please wait a minute and try again.' : 'Something went wrong. Please try again.');
  });

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm">
        <CardBody>
          <h1 className="text-lg font-semibold">Reset your password</h1>
          {sent ? (
            <div role="status" className="mt-4 space-y-3 text-sm">
              <p>If an account exists for that email, we&apos;ve sent a link to reset the password. It expires in 30 minutes.</p>
              <p className="text-muted-foreground">Nothing arrived? Check spam, or ask your restaurant owner to confirm the email on your account.</p>
              <Link className="text-primary hover:underline" href="/login">Back to sign in</Link>
            </div>
          ) : (
            <>
              <div role="tablist" aria-label="Account type" className="my-4 grid grid-cols-2 rounded-md border p-0.5 text-sm">
                {(['tenant', 'platform'] as const).map((m) => (
                  <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null); reset(); }}
                    className={cn('rounded px-3 py-1.5', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                    {m === 'tenant' ? 'Restaurant' : 'Platform admin'}
                  </button>
                ))}
              </div>
              <form method="post" onSubmit={onSubmit} className="space-y-3" noValidate>
                {mode === 'tenant' && <Field label="Restaurant ID" error={errors.tenantSlug?.message}><Input autoComplete="organization" {...register('tenantSlug')} /></Field>}
                <Field label="Email" error={errors.email?.message}><Input type="email" autoComplete="username" {...register('email')} /></Field>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <Button type="submit" className="w-full" disabled={isSubmitting}>{isSubmitting ? 'Sending…' : 'Send reset link'}</Button>
                <p className="text-center text-sm"><Link className="text-primary hover:underline" href="/login">Back to sign in</Link></p>
              </form>
            </>
          )}
        </CardBody>
      </Card>
    </main>
  );
}

export default function ForgotPasswordPage() {
  return <Suspense><ForgotPasswordForm /></Suspense>;
}
