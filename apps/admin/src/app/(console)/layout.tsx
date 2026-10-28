'use client';
import { Building2, History, KeyRound, ToggleLeft } from 'lucide-react';
import { Shell, type NavItem } from '@/components/shell';

const nav: NavItem[] = [
  { href: '/tenants', label: 'Tenants', icon: Building2 },
  { href: '/features', label: 'Features & plans', icon: ToggleLeft },
  { href: '/flag-history', label: 'Flag history', icon: History },
  { href: '/account', label: 'Account', icon: KeyRound },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <Shell audience="platform" title="RMS Console" nav={nav}>{children}</Shell>;
}
