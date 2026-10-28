import { Module } from '@nestjs/common';
import { DeviceController } from './device.controller';
import { DeviceService } from './device.service';
import { MenuController } from './menu.controller';
import { MenuCatalogService } from './menu-catalog.service';
import { MenuBulkService } from './menu-bulk.service';
import { FloorTablesController } from './floor-tables.controller';
import { FloorTablesService } from './floor-tables.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { CashierShiftsController } from './cashier-shifts.controller';
import { CashierShiftsService } from './cashier-shifts.service';
import { PrinterDispatchController } from './printer-dispatch.controller';
import { PrinterDispatchService } from './printer-dispatch.service';
import { PurchasingController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { MenuService } from './menu.service';
import { TenantController } from './tenant.controller';
import { TenantService } from './tenant.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [TenantController, DeviceController, MenuController, FloorTablesController, OrdersController, BillingController, InventoryController, CashierShiftsController, PrinterDispatchController, PurchasingController, SyncController, ReportsController],
  providers: [TenantService, DeviceService, MenuService, MenuCatalogService, MenuBulkService, FloorTablesService, OrdersService, BillingService, InventoryService, CashierShiftsService, PrinterDispatchService, PurchasingService, SyncService, ReportsService],
})
export class TenantModule {}
