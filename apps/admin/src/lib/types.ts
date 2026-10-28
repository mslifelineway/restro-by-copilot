export type PlanCode = 'trial' | 'starter' | 'growth' | 'enterprise';
export type TenantStatus = 'trial' | 'active' | 'suspended' | 'deleted';

export interface TenantRow { id: string; name: string; slug: string; status: TenantStatus; plan: PlanCode; created_at: string }
export interface TenantDetail extends TenantRow {
  timezone: string; currency: string; language: string;
  subscription: { status: string; trial_ends_at: string | null; current_period_end: string | null } | null;
  usage: { outlets: number; users: number };
}
export interface Plan { code: PlanCode; name: string; price_monthly_paise: number; limits: Record<string, number>; features: string[] }
export interface Feature { key: string; module: string; type: string; description: string; depends_on: string[]; kill_switch: boolean }
export interface Entitlement { key: string; module: string; enabled: boolean; source: 'kill_switch' | 'outlet_override' | 'tenant_override' | 'plan' | 'dependency' | 'none' }
export interface FlagAuditRow { id: string; tenant_id: string | null; feature_key: string; action: string; old_value: unknown; new_value: unknown; reason: string | null; actor_id: string | null; created_at: string }
export interface Me { kind: 'platform'; userId: string; role: 'super_admin' | 'support' }

export interface TenantMe {
  kind: 'tenant'; userId: string; tenantId: string; outletId: string | null;
  permissions: Record<string, Record<string, number | string | boolean>>;
  features: string[];
}
export type AnyMe = Me | TenantMe;
export interface TenantProfile { id: string; name: string; slug: string; status: TenantStatus; plan: PlanCode; timezone: string; currency: string; language: string; date_format: string }
export interface Outlet { id: string; name: string; code: string; address: Record<string, unknown>; gstin: string | null; timezone: string | null }
export interface Assignment { roleId: string; role: string; outletId: string | null }
export interface UserRow { id: string; email: string; name: string; status: 'active' | 'disabled'; roles: Assignment[] }
export interface RolePermission { permission: string; limits: Record<string, number | string | boolean> }
export interface RoleRow { id: string; name: string; is_system: boolean; permissions: RolePermission[] }
export interface DeviceRow { id: string; name: string; platform: string; outletId: string | null; status: 'active' | 'revoked'; lastSeenAt: string | null; createdAt: string }
export interface Subscription {
  status: string; billing_interval: string; trial_ends_at: string | null; current_period_end: string | null;
  plan: PlanCode; plan_name: string;
  limits: { outlets: number; users: number; ordersPerMonth: number; storageMb: number };
  outlets_used: number; users_used: number;
}
export interface AuditRow { id: string; actor_id: string | null; actor_kind: string; action: string; entity: string | null; entity_id: string | null; meta: Record<string, unknown>; created_at: string }
export interface SessionRow { id: string; deviceId: string | null; userAgent: string | null; ip: string | null; createdAt: string; expiresAt: string; current: boolean }
