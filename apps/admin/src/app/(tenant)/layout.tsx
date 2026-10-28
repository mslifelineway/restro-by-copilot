'use client';
import { Building, CreditCard, Home, KeyRound, ListChecks, MonitorSmartphone, Settings, Shield, Users } from 'lucide-react';
import { Shell, type NavItem } from '@/components/shell';

const nav: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: Home },
  { href: '/outlets', label: 'Outlets', icon: Building, permission: 'outlet:read' },
  { href: '/users', label: 'Users', icon: Users, permission: 'user:read' },
  { href: '/roles', label: 'Roles & permissions', icon: Shield, permission: 'role:read' },
  { href: '/devices', label: 'Devices', icon: MonitorSmartphone, permission: 'device:read' },
  { href: '/subscription', label: 'Subscription', icon: CreditCard, permission: 'subscription:read' },
  { href: '/audit-log', label: 'Audit log', icon: ListChecks, permission: 'audit:read' },
  { href: '/settings', label: 'Settings', icon: Settings, permission: 'tenant:read' },
  { href: '/security', label: 'Account', icon: KeyRound },
];

export default function TenantLayout({ children }: { children: React.ReactNode }) {
  return <Shell audience="tenant" title="Restaurant Admin" nav={nav}>{children}</Shell>;
}
