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
  'table:read', 'table:manage',
  'kot:manage',
  'bill:create', 'bill:void', 'bill:reprint', 'discount:apply', 'refund:create',
  'order:read', 'order:create', 'order:cancel', 'kot:read',
  'inventory:read', 'inventory:adjust', 'shift:read', 'shift:manage',
  'printer:read', 'printer:manage',
  'sync:push', 'sync:pull',
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
    permissions: ['menu:read', 'table:read', 'bill:create', 'bill:reprint', 'discount:apply', 'refund:create', 'order:read', 'order:create', 'shift:read', 'shift:manage', 'printer:read', 'report:read', 'sync:push', 'sync:pull'],
    limits: { 'discount:apply': { maxPercent: 10 }, 'refund:create': { maxAmountPaise: 50000 } },
  },
  Waiter: { permissions: ['menu:read', 'table:read', 'order:read', 'order:create', 'sync:push', 'sync:pull'] },
  Chef: { permissions: ['menu:read', 'inventory:read', 'kot:read', 'kot:manage', 'printer:read', 'sync:pull'] },
  Storekeeper: { permissions: ['inventory:read', 'inventory:adjust', 'menu:read'] },
  Accountant: { permissions: ['report:read', 'report:export', 'audit:read', 'subscription:read'] },
};
