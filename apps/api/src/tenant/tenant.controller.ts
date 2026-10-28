import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsEmail, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches, MinLength, ValidateNested,
} from 'class-validator';
import { PERMISSIONS } from '@rms/shared';
import { Ctx, ResponseMessage, RequirePermission, TenantOnly } from '../common/decorators';
import { PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { EntitlementService } from '../entitlements/entitlement.service';
import { TenantService } from './tenant.service';

class UpdateTenantDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @Length(3, 3) currency?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() dateFormat?: string;
}
class CreateOutletDto {
  @IsString() @Length(2, 100) name!: string;
  @Matches(/^[A-Z0-9_-]{2,20}$/) code!: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsObject() address?: object;
}
class UpdateOutletDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsObject() address?: object;
}
class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
}
class AssignmentDto { @IsUUID() roleId!: string; @IsOptional() @IsUUID() outletId?: string; }
class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @Length(2, 100) name!: string;
  @IsOptional() @IsString() @MinLength(10) password?: string;
  @IsOptional() @Matches(/^\d{4,8}$/, { message: 'pin must be 4-8 digits' }) pin?: string;
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AssignmentDto) assignments!: AssignmentDto[];
}
class PinDto { @Matches(/^\d{4,8}$/, { message: 'pin must be 4-8 digits' }) pin!: string; }
class UserRolesDto { @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => AssignmentDto) assignments!: AssignmentDto[]; }
class PermDto {
  @IsIn(PERMISSIONS as unknown as string[]) permission!: string;
  @IsOptional() @IsObject() limits?: Record<string, number | string | boolean>;
}
class CreateRoleDto {
  @IsString() @Length(2, 50) name!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => PermDto) permissions!: PermDto[];
}
class RolePermsDto { @IsArray() @ValidateNested({ each: true }) @Type(() => PermDto) permissions!: PermDto[]; }

@TenantOnly()
@Controller('v1')
export class TenantController {
  constructor(private svc: TenantService, private ent: EntitlementService) {}

  @ResponseMessage('Tenant fetched successfully')
  @Get('tenant') @RequirePermission('tenant:read')
  tenant(@Ctx() ctx: RequestCtx) { return this.svc.getTenant(ctx); }

  @ResponseMessage('Tenant updated successfully')
  @Patch('tenant') @RequirePermission('tenant:update')
  async update(@Ctx() ctx: RequestCtx, @Body() b: UpdateTenantDto) { await this.svc.updateTenant(ctx, b); }

  @ResponseMessage('Outlets fetched successfully')
  @Get('outlets') @RequirePermission('outlet:read')
  outlets(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.svc.listOutlets(ctx, q); }

  @ResponseMessage('Outlet created successfully')
  @Post('outlets') @RequirePermission('outlet:manage')
  createOutlet(@Ctx() ctx: RequestCtx, @Body() b: CreateOutletDto) { return this.svc.createOutlet(ctx, b); }

  @ResponseMessage('Users fetched successfully')
  @Patch('outlets/:id') @RequirePermission('outlet:manage') @ResponseMessage('Outlet updated successfully')
  async updateOutlet(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateOutletDto) { await this.svc.updateOutlet(ctx, id, b); }

  @Delete('outlets/:id') @RequirePermission('outlet:manage') @ResponseMessage('Outlet deleted successfully')
  async deleteOutlet(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.svc.deleteOutlet(ctx, id); }

  @Get('users') @RequirePermission('user:read')
  users(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.svc.listUsers(ctx, q); }

  @ResponseMessage('User created successfully')
  @Post('users') @RequirePermission('user:manage')
  createUser(@Ctx() ctx: RequestCtx, @Body() b: CreateUserDto) { return this.svc.createUser(ctx, b); }

  @ResponseMessage('PIN updated successfully')
  @Patch('users/:id') @RequirePermission('user:manage') @ResponseMessage('User updated successfully')
  async updateUser(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateUserDto) { await this.svc.updateUser(ctx, id, b); }

  @Post('users/:id/force-logout') @HttpCode(200) @RequirePermission('user:manage') @ResponseMessage('User signed out of all sessions')
  forceLogout(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.svc.forceLogout(ctx, id); }

  @Get('sessions') @ResponseMessage('Sessions fetched successfully')
  sessions(@Ctx() ctx: RequestCtx) { return this.svc.listOwnSessions(ctx); }

  @Delete('sessions/:id') @ResponseMessage('Session ended successfully')
  async endSession(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.svc.revokeOwnSession(ctx, id); }

  @Put('users/:id/pin') @RequirePermission('user:manage')
  async setPin(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: PinDto) { await this.svc.setPin(ctx, id, b.pin); }

  @ResponseMessage('User roles updated successfully')
  @Put('users/:id/roles') @RequirePermission('user:manage')
  async setUserRoles(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UserRolesDto) { await this.svc.setUserRoles(ctx, id, b.assignments); }

  @ResponseMessage('Roles fetched successfully')
  @Get('roles') @RequirePermission('role:read')
  roles(@Ctx() ctx: RequestCtx) { return this.svc.listRoles(ctx); }

  @ResponseMessage('Role created successfully')
  @Post('roles') @RequirePermission('role:manage')
  createRole(@Ctx() ctx: RequestCtx, @Body() b: CreateRoleDto) { return this.svc.createRole(ctx, b.name, b.permissions); }

  @ResponseMessage('Role permissions updated successfully')
  @Put('roles/:id/permissions') @RequirePermission('role:manage')
  async setRolePerms(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: RolePermsDto) { await this.svc.setRolePermissions(ctx, id, b.permissions); }

  @ResponseMessage('Subscription fetched successfully')
  @Get('subscription') @RequirePermission('subscription:read')
  subscription(@Ctx() ctx: RequestCtx) { return this.svc.getSubscription(ctx); }

  @ResponseMessage('Audit log fetched successfully')
  @Get('audit-log') @RequirePermission('audit:read')
  audit(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.svc.listAudit(ctx, q); }

  /** Effective entitlements for the POS/waiter app to cache (any authenticated tenant user). */
  @ResponseMessage('Entitlements fetched successfully')
  @Get('entitlements')
  async entitlements(@Ctx() ctx: RequestCtx) { return [...(await this.ent.resolve(ctx.tenantId!, ctx.outletId)).values()]; }
}
