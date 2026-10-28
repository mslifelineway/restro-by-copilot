import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MinLength } from 'class-validator';
import { Ctx, ResponseMessage, PlatformOnly } from '../common/decorators';
import { PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { PlatformService } from './platform.service';

const PLAN_CODES = ['trial', 'starter', 'growth', 'enterprise'];

class CreateTenantDto {
  @IsString() @Length(2, 100) name!: string;
  @Matches(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, { message: 'slug must be lowercase letters, digits and hyphens' }) slug!: string;
  @IsOptional() @IsIn(PLAN_CODES) planCode?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @Length(3, 3) currency?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() outletName?: string;
  @IsString() @Length(2, 100) ownerName!: string;
  @IsEmail() ownerEmail!: string;
  @IsString() @MinLength(10) ownerPassword!: string;
}
class FlagHistoryQuery extends PaginationQuery { @IsOptional() @IsUUID() tenantId?: string; }
class StatusDto { @IsIn(['active', 'suspended', 'deleted']) status!: 'active' | 'suspended' | 'deleted'; }
class PlanDto { @IsIn(PLAN_CODES) planCode!: string; }
class KillDto { @IsBoolean() on!: boolean; @IsString() @MinLength(3) reason!: string; }
class PlanFeatureDto { @IsBoolean() enabled!: boolean; }
class OverrideDto {
  @IsBoolean() enabled!: boolean;
  @IsString() @MinLength(3) reason!: string;
  @IsOptional() @Type(() => Date) @IsDate() expiresAt?: Date;
  @IsOptional() @IsUUID() outletId?: string;
}

@PlatformOnly()
@Controller('v1/platform')
export class PlatformController {
  constructor(private svc: PlatformService) {}

  @ResponseMessage('Tenant created successfully')
  @Post('tenants') @PlatformOnly('super_admin')
  createTenant(@Ctx() ctx: RequestCtx, @Body() b: CreateTenantDto) { return this.svc.createTenant(ctx, b); }

  @ResponseMessage('Tenants fetched successfully') @Get('tenants') listTenants(@Query() q: PaginationQuery) { return this.svc.listTenants(q); }
  @ResponseMessage('Tenant fetched successfully') @Get('tenants/:id') getTenant(@Param('id', ParseUUIDPipe) id: string) { return this.svc.getTenant(id); }

  @ResponseMessage('Tenant status updated successfully')
  @Patch('tenants/:id/status') @PlatformOnly('super_admin')
  async setStatus(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: StatusDto) { await this.svc.setStatus(ctx, id, b.status); }

  @ResponseMessage('Tenant plan updated successfully')
  @Patch('tenants/:id/plan') @PlatformOnly('super_admin')
  async changePlan(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: PlanDto) { await this.svc.changePlan(ctx, id, b.planCode); }

  @ResponseMessage('Plans fetched successfully') @Get('plans') plans() { return this.svc.listPlans(); }
  @ResponseMessage('Features fetched successfully') @Get('features') features() { return this.svc.listFeatures(); }
  @ResponseMessage('Flag history fetched successfully') @Get('flag-history') history(@Query() q: FlagHistoryQuery) { return this.svc.flagHistory(q, q.tenantId); }

  @ResponseMessage('Kill switch updated successfully')
  @Put('features/:key/kill-switch') @PlatformOnly('super_admin')
  async kill(@Ctx() ctx: RequestCtx, @Param('key') key: string, @Body() b: KillDto) { await this.svc.setKillSwitch(ctx, key, b.on, b.reason); }

  @ResponseMessage('Plan feature updated successfully')
  @Put('plans/:planCode/features/:key') @PlatformOnly('super_admin')
  async planFeature(@Ctx() ctx: RequestCtx, @Param('planCode') planCode: string, @Param('key') key: string, @Body() b: PlanFeatureDto) {
    await this.svc.setPlanFeature(ctx, planCode, key, b.enabled);
  }

  @ResponseMessage('Effective features fetched successfully')
  @Get('tenants/:id/features')
  effective(@Param('id', ParseUUIDPipe) id: string, @Query('outletId') outletId?: string) { return this.svc.effective(id, outletId); }

  @ResponseMessage('Feature override saved successfully')
  @Put('tenants/:id/features/:key') @PlatformOnly('super_admin')
  async override(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() b: OverrideDto) {
    await this.svc.setTenantFeature(ctx, id, key, b.enabled, b.reason, b.expiresAt, b.outletId);
  }

  @ResponseMessage('Feature override cleared successfully')
  @Delete('tenants/:id/features/:key') @PlatformOnly('super_admin')
  async clear(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Query('outletId') outletId?: string) {
    await this.svc.clearTenantFeature(ctx, id, key, outletId);
  }
}
