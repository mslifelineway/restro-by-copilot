import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsEmail, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { RequestCtx } from '../common/request-context';
import { PurchasingService } from './purchasing.service';

const QUANTITY_PATTERN = /^(?:0*[1-9]\d{0,14}(?:\.\d{1,3})?|0*\.\d{1,3})$/;
const MONEY_PATTERN = /^(0|[1-9]\d{0,18})$/;

class CreateSupplierDto {
  @IsString() @Length(2, 160) name!: string;
  @IsOptional() @IsString() @Length(0, 40) phone?: string;
  @IsOptional() @IsEmail() @Length(3, 254) email?: string;
}

class PurchaseOrderLineDto {
  @IsUUID() inventoryItemId!: string;
  @Matches(QUANTITY_PATTERN) quantity!: string;
  @Matches(MONEY_PATTERN) unitCostPaise!: string;
}

class CreatePurchaseOrderDto {
  @IsUUID() supplierId!: string;
  @IsOptional() @IsString() @Length(0, 500) notes?: string;
  @IsArray() @ArrayMaxSize(100) @ArrayUnique((line: PurchaseOrderLineDto) => line.inventoryItemId)
  @ValidateNested({ each: true }) @Type(() => PurchaseOrderLineDto) lines!: PurchaseOrderLineDto[];
}

class ReceiptLineDto {
  @IsUUID() purchaseOrderLineId!: string;
  @Matches(QUANTITY_PATTERN) quantity!: string;
}

class ReceivePurchaseOrderDto {
  @IsOptional() @IsString() @Length(0, 100) reference?: string;
  @IsArray() @ArrayMaxSize(100) @ArrayUnique((line: ReceiptLineDto) => line.purchaseOrderLineId)
  @ValidateNested({ each: true }) @Type(() => ReceiptLineDto) lines!: ReceiptLineDto[];
}

@TenantOnly()
@Controller('v1/purchasing')
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Get('suppliers') @RequirePermission('inventory:read') @ResponseMessage('Suppliers fetched successfully')
  suppliers(@Ctx() ctx: RequestCtx) { return this.purchasing.listSuppliers(ctx); }

  @Post('suppliers') @RequirePermission('inventory:adjust') @ResponseMessage('Supplier created successfully')
  createSupplier(@Ctx() ctx: RequestCtx, @Body() body: CreateSupplierDto) { return this.purchasing.createSupplier(ctx, body); }

  @Get('orders') @RequirePermission('inventory:read') @ResponseMessage('Purchase orders fetched successfully')
  orders(@Ctx() ctx: RequestCtx) { return this.purchasing.listOrders(ctx); }

  @Post('orders') @RequirePermission('inventory:adjust') @ResponseMessage('Purchase order created successfully')
  createOrder(@Ctx() ctx: RequestCtx, @Body() body: CreatePurchaseOrderDto) { return this.purchasing.createOrder(ctx, body); }

  @Post('orders/:id/receipts') @RequirePermission('inventory:adjust') @ResponseMessage('Purchase receipt recorded successfully')
  receive(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReceivePurchaseOrderDto) {
    return this.purchasing.receive(ctx, id, body.reference, body.lines);
  }

  @Post('orders/:id/cancel') @RequirePermission('inventory:adjust') @ResponseMessage('Purchase order cancelled successfully')
  cancel(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.purchasing.cancel(ctx, id); }
}
