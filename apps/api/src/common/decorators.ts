import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Permission } from '@rms/shared';
import { RequestCtx } from './request-context';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRE_PERMISSION = 'requirePermission';
export const RequirePermission = (p: Permission) => SetMetadata(REQUIRE_PERMISSION, p);

export const REQUIRE_FEATURE = 'requireFeature';
export const RequireFeature = (key: string) => SetMetadata(REQUIRE_FEATURE, key);

export const PLATFORM_ONLY = 'platformOnly';
/** Platform (super admin / support) users only. Pass 'super_admin' to exclude support agents. */
export const PlatformOnly = (role: 'any' | 'super_admin' = 'any') => SetMetadata(PLATFORM_ONLY, role);

export const TENANT_ONLY = 'tenantOnly';
export const TenantOnly = () => SetMetadata(TENANT_ONLY, true);

export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext): RequestCtx => ec.switchToHttp().getRequest().ctx);

export const RESPONSE_MESSAGE = 'responseMessage';
/** Message shown in the success envelope, e.g. @ResponseMessage('User fetched successfully'). */
export const ResponseMessage = (m: string) => SetMetadata(RESPONSE_MESSAGE, m);

export interface ClientMeta { ip: string | null; userAgent: string | null }
/** Caller IP (honours trust-proxy) and user agent, recorded on sessions. */
export const Client = createParamDecorator((_: unknown, ec: ExecutionContext): ClientMeta => {
  const req = ec.switchToHttp().getRequest();
  return { ip: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 300) ?? null };
});
