'use client';
import { Banknote, BarChart3, Building, CreditCard, Home, Inbox, KeyRound, ListChecks, MonitorSmartphone, Package, ReceiptText, Settings, Shield, UtensilsCrossed, Users } from 'lucide-react';
import { Shell, type NavItem } from '@/components/shell';

const nav: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: Home },
  { href: '/outlets', label: 'Outlets', icon: Building, permission: 'outlet:read' },
  { href: '/users', label: 'Users', icon: Users, permission: 'user:read' },
  { href: '/roles', label: 'Roles & permissions', icon: Shield, permission: 'role:read' },
  { href: '/devices', label: 'Devices', icon: MonitorSmartphone, permission: 'device:read' },
  { href: '/sync-inbox', label: 'Offline sync inbox', icon: Inbox, permission: 'device:manage' },
  { href: '/cashier-shifts', label: 'Cashier shifts', icon: Banknote, permission: 'report:read' },
  { href: '/billing', label: 'Billing', icon: ReceiptText, permission: 'bill:reprint' },
  { href: '/menu', label: 'Menu', icon: UtensilsCrossed, permission: 'menu:read' },
  { href: '/floor', label: 'Floor & tables', icon: Building, permission: 'table:read' },
  { href: '/inventory', label: 'Inventory', icon: Package, permission: 'inventory:read' },
  { href: '/reports', label: 'Sales reports', icon: BarChart3, permission: 'report:read' },
  { href: '/purchasing', label: 'Inventory & purchasing', icon: Package, permission: 'inventory:read' },
  { href: '/subscription', label: 'Subscription', icon: CreditCard, permission: 'subscription:read' },
  { href: '/audit-log', label: 'Audit log', icon: ListChecks, permission: 'audit:read' },
  { href: '/settings', label: 'Settings', icon: Settings, permission: 'tenant:read' },
  { href: '/security', label: 'Account', icon: KeyRound },
];

export default function TenantLayout({ children }: { children: React.ReactNode }) {
  return <Shell audience="tenant" title="Restaurant Admin" nav={nav}>{children}</Shell>;
}
