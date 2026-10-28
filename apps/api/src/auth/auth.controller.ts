import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@rms/shared';
import { config } from '../config';
import { Client, ClientMeta, Ctx, ResponseMessage, Public } from '../common/decorators';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PermissionService } from './permission.service';

class TenantLoginDto {
  @IsString() @Length(3, 50) tenantSlug!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
  /** Set by POS/waiter/KDS apps; must be a registered, active device of this tenant. */
  @IsOptional() @IsUUID() deviceId?: string;
}
class PinLoginDto {
  @IsString() @Length(3, 50) tenantSlug!: string;
  @IsEmail() email!: string;
  @IsString() @Length(4, 8) pin!: string;
  @IsOptional() @IsUUID() deviceId?: string;
}
class ChangePasswordDto {
  @IsString() @MinLength(1) currentPassword!: string;
  @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(PASSWORD_MAX_LENGTH) newPassword!: string;
}
class ForgotPasswordDto {
  /** Omit for platform users. */
  @IsOptional() @IsString() @Length(3, 50) tenantSlug?: string;
  @IsEmail() email!: string;
}
class ResetPasswordDto {
  @IsString() @Length(20, 200) token!: string;
  @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(PASSWORD_MAX_LENGTH) newPassword!: string;
}
class RefreshDto { @IsString() @Length(20, 200) refreshToken!: string; }
class PlatformLoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}

const authLimit = { default: { limit: config.throttleAuthPerMin, ttl: 60_000 } };

@Controller('v1/auth')
export class AuthController {
  constructor(private auth: AuthService, private passwords: PasswordService, private perms: PermissionService, private ent: EntitlementService, private db: DbService) {}

  @ResponseMessage('Logged in successfully')
  @Public() @Throttle(authLimit) @Post('login') @HttpCode(200)
  login(@Body() b: TenantLoginDto, @Client() m: ClientMeta) { return this.auth.tenantLogin(b.tenantSlug, b.email, b.password, 'password', m, b.deviceId); }

  /** POS staff quick login. Hashed PIN, shared lockout policy. Device binding lands with device registration. */
  @ResponseMessage('Logged in successfully')
  @Public() @Throttle(authLimit) @Post('pin-login') @HttpCode(200)
  pinLogin(@Body() b: PinLoginDto, @Client() m: ClientMeta) { return this.auth.tenantLogin(b.tenantSlug, b.email, b.pin, 'pin', m, b.deviceId); }

  @ResponseMessage('Logged in successfully')
  @Public() @Throttle(authLimit) @Post('platform/login') @HttpCode(200)
  platformLogin(@Body() b: PlatformLoginDto, @Client() m: ClientMeta) { return this.auth.platformLogin(b.email, b.password, m); }

  /** Rotates the refresh token. Public: the refresh token itself is the credential. */
  @Public() @Throttle(authLimit) @Post('refresh') @HttpCode(200) @ResponseMessage('Token refreshed successfully')
  refresh(@Body() b: RefreshDto, @Client() m: ClientMeta) { return this.auth.refresh(b.refreshToken, m); }

  @Throttle(authLimit) @Post('change-password') @HttpCode(200) @ResponseMessage('Password changed. Other sessions were signed out.')
  changePassword(@Ctx() ctx: RequestCtx, @Body() b: ChangePasswordDto) { return this.passwords.change(ctx, b.currentPassword, b.newPassword); }

  /** Always answers the same way, whether or not the account exists. */
  @Public() @Throttle(authLimit) @Post('forgot-password') @HttpCode(200) @ResponseMessage('If an account exists for that email, a reset link has been sent.')
  async forgotPassword(@Body() b: ForgotPasswordDto, @Client() m: ClientMeta) { await this.passwords.requestReset(b.tenantSlug, b.email, m.ip); }

  @Public() @Throttle(authLimit) @Post('reset-password') @HttpCode(200) @ResponseMessage('Password updated. You can now sign in.')
  async resetPassword(@Body() b: ResetPasswordDto) { await this.passwords.reset(b.token, b.newPassword); }

  @Post('logout') @HttpCode(200) @ResponseMessage('Logged out successfully')
  async logout(@Ctx() ctx: RequestCtx) { await this.auth.logout(ctx.sessionId); }

  @Post('logout-all') @HttpCode(200) @ResponseMessage('All sessions ended')
  async logoutAll(@Ctx() ctx: RequestCtx) { return { revoked: await this.auth.logoutAll(ctx.kind, ctx.userId) }; }

  @ResponseMessage('Profile fetched successfully')
  @Get('me')
  async me(@Ctx() ctx: RequestCtx) {
    if (ctx.kind === 'platform') return { kind: 'platform', userId: ctx.userId, role: ctx.platformRole };
    const perms = await this.perms.forUser(ctx.tenantId!, ctx.userId, ctx.outletId);
    const ent = await this.ent.resolve(ctx.tenantId!, ctx.outletId);
    return {
      kind: 'tenant',
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      outletId: ctx.outletId ?? null,
      permissions: Object.fromEntries(perms),
      features: [...ent.values()].filter((e) => e.enabled).map((e) => e.key),
    };
  }
}
