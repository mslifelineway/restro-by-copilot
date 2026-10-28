'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/query-state';
import { useMe } from '@/lib/use-me';

/** Sends each kind of user to their own console. */
export default function Home() {
  const router = useRouter();
  const me = useMe();
  useEffect(() => {
    if (me.data) router.replace(me.data.kind === 'platform' ? '/tenants' : '/dashboard');
  }, [me.data, router]);
  return <Loading />;
}
