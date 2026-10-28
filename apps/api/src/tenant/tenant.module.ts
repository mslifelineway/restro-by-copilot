import { Module } from '@nestjs/common';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';
import { TenantController } from './tenant.controller';
import { TenantService } from './tenant.service';

@Module({ controllers: [TenantController, DeviceController], providers: [TenantService, DeviceService] })
export class TenantModule {}
