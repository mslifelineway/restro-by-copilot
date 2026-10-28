import { PermissionLimits } from '@rms/shared';

export interface RequestCtx {
  kind: 'tenant' | 'platform';
  userId: string;
  /** session id from the access token (`sid`) */
  sessionId: string;
  /** tenant users only */
  tenantId?: string;
  /** Optional x-outlet-id header: narrows permission scope and feature overrides to one outlet. */
  outletId?: string;
  /** platform users only */
  platformRole?: 'super_admin' | 'support';
  /** resolved by PermissionGuard for the current handler */
  limits?: PermissionLimits;
}

export interface JwtPayload {
  sub: string;
  kind: 'tenant' | 'platform';
  tid?: string;
  sid: string;
}
