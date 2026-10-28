'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Field } from '@/components/field';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const base = { email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Password is required') };
const schemas = {
  tenant: z.object({ tenantSlug: z.string().min(3, 'Restaurant ID is required'), ...base }),
  platform: z.object(base),
};
type Mode = keyof typeof schemas;
type Form = { tenantSlug?: string; email: string; password: string };

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('tenant');
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<Form>({
    resolver: (values, ctx, opts) => zodResolver(schemas[mode])(values, ctx, opts as never) as never,
  });

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, ...v }) });
    if (res.ok) {
      qc.clear();
      router.replace(mode === 'tenant' ? '/dashboard' : '/tenants');
      return;
    }
    const body = await res.json().catch(() => null);
    setError(res.status === 429 ? 'Too many attempts or account locked. Try again later.' : body?.error?.message ?? 'Sign in failed');
  });

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm">
        <CardBody>
          <h1 className="text-lg font-semibold">RMS</h1>
          <div role="tablist" aria-label="Sign in as" className="my-4 grid grid-cols-2 rounded-md border p-0.5 text-sm">
            {(['tenant', 'platform'] as const).map((m) => (
              <button
                key={m} type="button" role="tab" aria-selected={mode === m}
                onClick={() => { setMode(m); setError(null); reset(); }}
                className={cn('rounded px-3 py-1.5', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
              >
                {m === 'tenant' ? 'Restaurant' : 'Platform admin'}
              </button>
            ))}
          </div>
          <form method="post" onSubmit={onSubmit} className="space-y-3" noValidate>
            {mode === 'tenant' && (
              <Field label="Restaurant ID" hint="The short name your account was created with" error={errors.tenantSlug?.message}>
                <Input autoComplete="organization" {...register('tenantSlug')} />
              </Field>
            )}
            <Field label="Email" error={errors.email?.message}><Input type="email" autoComplete="username" {...register('email')} /></Field>
            <Field label="Password" error={errors.password?.message}><Input type="password" autoComplete="current-password" {...register('password')} /></Field>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>{isSubmitting ? 'Signing in…' : 'Sign in'}</Button>
            <p className="text-center text-sm"><Link className="text-primary hover:underline" href={`/forgot-password?as=${mode}`}>Forgot your password?</Link></p>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
