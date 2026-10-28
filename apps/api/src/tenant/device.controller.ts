import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { DeviceService } from './device.service';

class RegisterDeviceDto {
  @IsString() @Length(2, 100) name!: string;
  @IsIn(['android', 'ios', 'windows', 'web']) platform!: string;
  @IsOptional() @IsUUID() outletId?: string;
}

@TenantOnly()
@Controller('v1/devices')
export class DeviceController {
  constructor(private svc: DeviceService) {}

  @Post() @RequirePermission('device:manage') @ResponseMessage('Device registered successfully')
  register(@Ctx() ctx: RequestCtx, @Body() b: RegisterDeviceDto) { return this.svc.register(ctx, b); }

  @Get() @RequirePermission('device:read') @ResponseMessage('Devices fetched successfully')
  list(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.svc.list(ctx, q); }

  @Post(':id/revoke') @HttpCode(200) @RequirePermission('device:manage') @ResponseMessage('Device revoked successfully')
  revoke(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.svc.revoke(ctx, id); }
}
