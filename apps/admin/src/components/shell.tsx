'use client';
import type { LucideIcon } from 'lucide-react';
import { Flag, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useMe } from '@/lib/use-me';
import { cn } from '@/lib/utils';
import { Loading } from './query-state';
import { Button } from './ui/button';

export interface NavItem { href: string; label: string; icon: LucideIcon; /** tenant permission needed to see the item */ permission?: string }

/** Authenticated app shell. `audience` guards the area: the wrong kind of user is sent to their own console. */
export function Shell({ audience, title, nav, children }: { audience: 'platform' | 'tenant'; title: string; nav: NavItem[]; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const me = useMe();

  useEffect(() => {
    if (me.data && me.data.kind !== audience) router.replace(me.data.kind === 'platform' ? '/tenants' : '/dashboard');
  }, [me.data, audience, router]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  }

  if (me.isLoading || (me.data && me.data.kind !== audience)) return <Loading />;
  const visible = nav.filter((n) => !n.permission || (me.data?.kind === 'tenant' && n.permission in me.data.permissions));

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex flex-col border-b md:w-60 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4 font-semibold"><Flag className="size-4 text-primary" /> {title}</div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col">
          {visible.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={path.startsWith(href) ? 'page' : undefined}
              className={cn('flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted', path.startsWith(href) && 'bg-muted font-medium')}
            >
              <Icon className="size-4" /> {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden items-center justify-end border-t p-3 md:flex">
          <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out"><LogOut className="size-4" /> Sign out</Button>
        </div>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
