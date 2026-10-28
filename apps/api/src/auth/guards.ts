import { AppException } from '../common/errors';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Permission } from '@rms/shared';
import {
  IS_PUBLIC, PLATFORM_ONLY, REQUIRE_FEATURE, REQUIRE_PERMISSION, TENANT_ONLY,
} from '../common/decorators';
import { JwtPayload, RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { PermissionService } from './permission.service';
import { SessionService } from './session.service';
import { TenantStateService } from './tenant-state.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard chain step 1+2: verify token and set tenant/platform context. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
    private tenants: TenantStateService,
    private db: DbService,
    private sessions: SessionService,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ec.getHandler(), ec.getClass()])) return true;
    const req = ec.switchToHttp().getRequest();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) throw new AppException(HttpStatus.UNAUTHORIZED, 'AUTH_TOKEN_MISSING', 'Missing bearer token');
    let p: JwtPayload;
    try { p = await this.jwt.verifyAsync<JwtPayload>(m[1]); } catch { throw new AppException(HttpStatus.UNAUTHORIZED, 'AUTH_TOKEN_INVALID', 'Invalid or expired token'); }

    if (!p.sid || !(await this.sessions.isActive(p.sid))) throw new AppException(HttpStatus.UNAUTHORIZED, 'SESSION_REVOKED', 'Session has ended; sign in again');

    if (p.kind === 'platform') {
      const row = await this.db.tx({ platform: true }, async (c) =>
        (await c.query('SELECT role FROM platform_users WHERE id = $1', [p.sub])).rows[0]);
      if (!row) throw new UnauthorizedException();
      req.ctx = { kind: 'platform', userId: p.sub, sessionId: p.sid, platformRole: row.role } satisfies RequestCtx;
      return true;
    }

    const tenant = p.tid ? await this.tenants.get(p.tid) : null;
    if (!tenant || tenant.status === 'deleted') throw new UnauthorizedException();
    if (tenant.status === 'suspended') throw new AppException(HttpStatus.FORBIDDEN, 'TENANT_SUSPENDED', 'Tenant is suspended');
    const outletId = req.headers['x-outlet-id'] as string | undefined;
    if (outletId && !UUID.test(outletId)) throw new AppException(HttpStatus.FORBIDDEN, 'INVALID_OUTLET_HEADER', 'Invalid x-outlet-id');
    req.ctx = { kind: 'tenant', userId: p.sub, sessionId: p.sid, tenantId: tenant.id, outletId } satisfies RequestCtx;
    return true;
  }
}

/** Guard chain step 3: platform / tenant audience. */
@Injectable()
export class AudienceGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ec: ExecutionContext): boolean {
    const ctx: RequestCtx | undefined = ec.switchToHttp().getRequest().ctx;
    if (!ctx) return true; // public route
    const h = [ec.getHandler(), ec.getClass()];
    const platform = this.reflector.getAllAndOverride<'any' | 'super_admin'>(PLATFORM_ONLY, h);
    if (platform) {
      if (ctx.kind !== 'platform') throw new AppException(HttpStatus.FORBIDDEN, 'PLATFORM_ACCESS_REQUIRED', 'Platform access required');
      if (platform === 'super_admin' && ctx.platformRole !== 'super_admin') throw new AppException(HttpStatus.FORBIDDEN, 'SUPER_ADMIN_REQUIRED', 'Super admin required');
    }
    if (this.reflector.getAllAndOverride<boolean>(TENANT_ONLY, h) && ctx.kind !== 'tenant') throw new AppException(HttpStatus.FORBIDDEN, 'TENANT_ACCESS_REQUIRED', 'Tenant access required');
    return true;
  }
}

/** Guard chain step 4: module entitlement (M3A). Enforced server-side, not just UI. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private reflector: Reflector, private ent: EntitlementService) {}
  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<string>(REQUIRE_FEATURE, [ec.getHandler(), ec.getClass()]);
    if (!key) return true;
    const ctx: RequestCtx = ec.switchToHttp().getRequest().ctx;
    if (ctx?.kind !== 'tenant' || !(await this.ent.isEnabled(key, ctx.tenantId!, ctx.outletId))) {
      throw new AppException(HttpStatus.FORBIDDEN, 'FEATURE_DISABLED', `Feature '${key}' is not enabled`, { feature: key });
    }
    return true;
  }
}

/** Guard chain step 5+6: permission and outlet scope. Limits are exposed on ctx for handlers. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector, private perms: PermissionService) {}
  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const need = this.reflector.getAllAndOverride<Permission>(REQUIRE_PERMISSION, [ec.getHandler(), ec.getClass()]);
    if (!need) return true;
    const ctx: RequestCtx = ec.switchToHttp().getRequest().ctx;
    if (ctx?.kind !== 'tenant') throw new AppException(HttpStatus.FORBIDDEN, 'TENANT_USER_REQUIRED', 'Tenant user required');
    const limits = await this.perms.has(ctx.tenantId!, ctx.userId, need, ctx.outletId);
    if (!limits) throw new AppException(HttpStatus.FORBIDDEN, 'PERMISSION_DENIED', `Missing permission ${need}`, { permission: need });
    ctx.limits = limits;
    return true;
  }
}
