import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Min, ValidateNested } from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { RequestCtx } from '../common/request-context';
import { BillingService } from './billing.service';

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,18})$/;
const DISCOUNT_VALUE_PATTERN = /^(0|[1-9]\d{0,18})(\.\d{1,2})?$/;

class InvoiceDiscountDto {
  @IsIn(['PERCENTAGE', 'FIXED']) type!: 'PERCENTAGE' | 'FIXED';
  @IsString() @Matches(DISCOUNT_VALUE_PATTERN) value!: string;
}

class FinalizeInvoiceDto {
  @IsOptional() @Matches(/^[A-Z0-9]{1,6}$/) series?: string;
  @IsOptional() @IsIn(['INTRA_STATE', 'INTER_STATE']) taxMode?: 'INTRA_STATE' | 'INTER_STATE';
  @IsOptional() @ValidateNested() @Type(() => InvoiceDiscountDto) discount?: InvoiceDiscountDto;
  @IsOptional() @Matches(AMOUNT_PATTERN) tipAmount?: string;
}

class PaymentDto {
  @IsIn(['CASH', 'CARD', 'UPI', 'OTHER']) method!: 'CASH' | 'CARD' | 'UPI' | 'OTHER';
  @Matches(/^[1-9]\d{0,18}$/) amount!: string;
  @IsOptional() @IsString() @Length(0, 100) reference?: string;
}

class InvoiceVoidDto {
  @IsString() @Length(3, 500) reason!: string;
}

class RefundDto {
  @IsUUID() paymentId!: string;
  @IsIn(['CASH', 'CARD', 'UPI', 'OTHER']) method!: 'CASH' | 'CARD' | 'UPI' | 'OTHER';
  @Matches(/^[1-9]\d{0,18}$/) amount!: string;
  @IsString() @Length(3, 500) reason!: string;
  @IsOptional() @IsString() @Length(0, 100) reference?: string;
}

class MergeOrdersDto {
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(20) @ArrayUnique() @IsUUID(undefined, { each: true })
  orderIds!: string[];
}

class SplitInvoiceLineDto {
  @IsUUID() orderItemId!: string;
  @IsInt() @Min(1) quantity!: number;
}

class SplitInvoiceCheckDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => SplitInvoiceLineDto)
  items!: SplitInvoiceLineDto[];
  @IsOptional() @ValidateNested() @Type(() => InvoiceDiscountDto) discount?: InvoiceDiscountDto;
  @IsOptional() @Matches(AMOUNT_PATTERN) tipAmount?: string;
}

class SplitInvoiceDto {
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => SplitInvoiceCheckDto)
  checks!: SplitInvoiceCheckDto[];
  @IsOptional() @Matches(/^[A-Z0-9]{1,6}$/) series?: string;
  @IsOptional() @IsIn(['INTRA_STATE', 'INTER_STATE']) taxMode?: 'INTRA_STATE' | 'INTER_STATE';
}

class BillingSettingsDto {
  @IsIn(['NONE', 'FIXED', 'PERCENTAGE']) serviceChargeMode!: 'NONE' | 'FIXED' | 'PERCENTAGE';
  @IsString() @Matches(DISCOUNT_VALUE_PATTERN) serviceChargeValue!: string;
  @IsOptional() @IsString() @Length(1, 30) serviceChargeTaxCode?: string | null;
}

@TenantOnly()
@Controller('v1')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('orders/:id/invoice') @RequirePermission('bill:create') @ResponseMessage('Invoice finalized successfully')
  finalize(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) orderId: string, @Body() body: FinalizeInvoiceDto) {
    return this.billing.finalize(
      ctx, orderId, body.series ?? 'A', body.taxMode ?? 'INTRA_STATE',
      { discount: body.discount, tipAmount: body.tipAmount ?? '0' },
    );
  }

  @Post('orders/:id/merge') @RequirePermission('bill:create') @ResponseMessage('Orders merged for billing')
  mergeOrders(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) primaryOrderId: string, @Body() body: MergeOrdersDto) {
    return this.billing.mergeOrders(ctx, primaryOrderId, body.orderIds);
  }

  @Post('orders/:id/invoices/split') @RequirePermission('bill:create') @ResponseMessage('Split invoices finalized successfully')
  splitInvoices(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) orderId: string, @Body() body: SplitInvoiceDto) {
    return this.billing.splitInvoices(
      ctx, orderId, body.checks, body.series ?? 'A', body.taxMode ?? 'INTRA_STATE',
    );
  }

  @Get('billing/settings') @RequirePermission('bill:reprint') @ResponseMessage('Billing settings fetched successfully')
  getSettings(@Ctx() ctx: RequestCtx) { return this.billing.getSettings(ctx); }

  @Put('billing/settings') @RequirePermission('tenant:update') @ResponseMessage('Billing settings updated successfully')
  setSettings(@Ctx() ctx: RequestCtx, @Body() body: BillingSettingsDto) {
    return this.billing.setSettings(ctx, body);
  }

  @Get('invoices/:id') @RequirePermission('bill:reprint') @ResponseMessage('Invoice fetched successfully')
  get(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.billing.get(ctx, id); }

  @Post('invoices/:id/payments') @RequirePermission('bill:create') @ResponseMessage('Payment recorded successfully')
  payment(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: PaymentDto) {
    return this.billing.recordPayment(ctx, id, body.method, body.amount, body.reference);
  }

  @Post('invoices/:id/void') @RequirePermission('bill:void') @ResponseMessage('Invoice voided successfully')
  void(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: InvoiceVoidDto) {
    return this.billing.void(ctx, id, body.reason);
  }

  @Post('invoices/:id/refunds') @RequirePermission('refund:create') @ResponseMessage('Refund recorded successfully')
  refund(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: RefundDto) {
    return this.billing.refund(ctx, id, body.paymentId, body.method, body.amount, body.reason, body.reference);
  }
}
