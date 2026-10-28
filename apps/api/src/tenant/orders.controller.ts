import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min,
  ValidateNested,
} from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { OrdersService } from './orders.service';

class OrderLineDto {
  @IsUUID() variantId!: string;
  @IsInt() @Min(1) @Max(1000) quantity!: number;
  @IsOptional() @IsString() @Length(0, 500) notes?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsUUID(undefined, { each: true }) addOnIds?: string[];
}

class CreateOrderDto {
  @IsIn(['DINE_IN', 'TAKEAWAY', 'DELIVERY']) orderType!: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  @IsOptional() @IsUUID() tableId?: string;
  @IsOptional() @IsString() @Length(0, 500) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => OrderLineDto) items!: OrderLineDto[];
}

class TransferTableDto {
  @IsUUID() tableId!: string;
}

class OrderWaiterDto {
  @IsOptional() @IsUUID() userId?: string;
}

class MergeTablesDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID(undefined, { each: true })
  tableIds!: string[];
}

class UnmergeTablesDto extends MergeTablesDto {}

class KotStatusDto {
  @IsIn(['PREPARING', 'READY', 'SERVED']) status!: 'PREPARING' | 'READY' | 'SERVED';
}

class KotQueueQuery extends PaginationQuery {
  @IsOptional() @IsIn(['QUEUED', 'PREPARING', 'READY']) status?: 'QUEUED' | 'PREPARING' | 'READY';
}

@TenantOnly()
@Controller('v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('kot/queue') @RequirePermission('kot:read') @ResponseMessage('Kitchen queue fetched successfully')
  kotQueue(@Ctx() ctx: RequestCtx, @Query() q: KotQueueQuery) { return this.orders.kotQueue(ctx, q.status, q); }

  @Get('waiters') @RequirePermission('order:create') @ResponseMessage('Outlet waiters fetched successfully')
  waiters(@Ctx() ctx: RequestCtx) { return this.orders.listWaiters(ctx); }

  @Get() @RequirePermission('order:read') @ResponseMessage('Orders fetched successfully')
  list(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.orders.list(ctx, q); }

  @Get(':id') @RequirePermission('order:read') @ResponseMessage('Order fetched successfully')
  get(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.orders.get(ctx, id); }

  @Post() @RequirePermission('order:create') @ResponseMessage('Order created successfully')
  create(@Ctx() ctx: RequestCtx, @Body() body: CreateOrderDto) { return this.orders.create(ctx, body); }

  @Post(':id/kot') @RequirePermission('order:create') @ResponseMessage('Kitchen ticket created successfully')
  createKot(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.orders.createKot(ctx, id); }

  @Post(':id/hold') @RequirePermission('order:create') @ResponseMessage('Order held successfully')
  async hold(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.orders.hold(ctx, id); }

  @Post(':id/resume') @RequirePermission('order:create') @ResponseMessage('Order resumed successfully')
  async resume(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.orders.resume(ctx, id); }

  @Post(':id/transfer-table') @RequirePermission('order:create') @ResponseMessage('Order transferred to another table')
  async transferTable(
    @Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: TransferTableDto,
  ) { await this.orders.transferTable(ctx, id, body.tableId); }

  @Post(':id/merge-tables') @RequirePermission('order:create') @ResponseMessage('Tables joined to order successfully')
  mergeTables(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: MergeTablesDto) {
    return this.orders.mergeTables(ctx, id, body.tableIds);
  }

  @Post(':id/unmerge-tables') @RequirePermission('order:create') @ResponseMessage('Tables released from order successfully')
  unmergeTables(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: UnmergeTablesDto) {
    return this.orders.unmergeTables(ctx, id, body.tableIds);
  }

  @Put(':id/waiter') @RequirePermission('order:create') @ResponseMessage('Order waiter updated successfully')
  async assignWaiter(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: OrderWaiterDto) {
    await this.orders.assignWaiter(ctx, id, body.userId ?? null);
  }

  @Post(':id/cancel') @RequirePermission('order:cancel') @ResponseMessage('Order cancelled successfully')
  async cancel(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.orders.cancel(ctx, id); }

  @Patch('kot/:id/status') @RequirePermission('kot:manage') @ResponseMessage('Kitchen ticket status updated successfully')
  async updateKot(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: KotStatusDto) {
    await this.orders.updateKotStatus(ctx, id, body.status);
  }
}
