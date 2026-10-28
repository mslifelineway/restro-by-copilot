/** Fixed permission catalog (resource:action). Tenants cannot create new permissions. */
export const PERMISSIONS = [
  'tenant:read', 'tenant:update',
  'outlet:read', 'outlet:manage',
  'user:read', 'user:manage',
  'device:read', 'device:manage',
  'role:read', 'role:manage',
  'subscription:read',
  'audit:read',
  'menu:read', 'menu:edit', 'menu:edit_price', 'menu:publish',
  'bill:create', 'bill:void', 'bill:reprint', 'discount:apply', 'refund:create',
  'order:create', 'order:cancel',
  'inventory:read', 'inventory:adjust',
  'report:read', 'report:export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionLimits {
  /** e.g. discount:apply -> { maxPercent: 10 }, refund:create -> { maxAmountPaise: 50000 } */
  [key: string]: number | string | boolean;
}

export type SystemRoleName =
  | 'Owner' | 'Manager' | 'Cashier' | 'Waiter' | 'Chef' | 'Storekeeper' | 'Accountant';

const ALL = [...PERMISSIONS] as Permission[];

export const SYSTEM_ROLES: Record<SystemRoleName, { permissions: Permission[]; limits?: Partial<Record<Permission, PermissionLimits>> }> = {
  Owner: { permissions: ALL },
  Manager: {
    permissions: ALL.filter((p) => !['tenant:update', 'role:manage', 'subscription:read'].includes(p)),
  },
  Cashier: {
    permissions: ['menu:read', 'bill:create', 'bill:reprint', 'discount:apply', 'refund:create', 'order:create', 'report:read'],
    limits: { 'discount:apply': { maxPercent: 10 }, 'refund:create': { maxAmountPaise: 50000 } },
  },
  Waiter: { permissions: ['menu:read', 'order:create'] },
  Chef: { permissions: ['menu:read', 'inventory:read'] },
  Storekeeper: { permissions: ['inventory:read', 'inventory:adjust', 'menu:read'] },
  Accountant: { permissions: ['report:read', 'report:export', 'audit:read', 'subscription:read'] },
};
