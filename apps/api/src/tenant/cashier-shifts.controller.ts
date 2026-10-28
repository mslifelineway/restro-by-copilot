import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { CashierShiftsService } from './cashier-shifts.service';

const MONEY_PATTERN = /^(0|[1-9]\d{0,18})$/;

class OpenShiftDto { @Matches(MONEY_PATTERN) openingCash!: string; }
class CloseShiftDto { @Matches(MONEY_PATTERN) countedCash!: string; }
class ShiftAdjustmentDto {
  @IsIn(['IN', 'OUT']) direction!: 'IN' | 'OUT';
  @Matches(/^[1-9]\d{0,18}$/) amount!: string;
  @IsString() @Length(3, 500) reason!: string;
}

@TenantOnly()
@Controller('v1/cashier-shifts')
export class CashierShiftsController {
  constructor(private readonly shifts: CashierShiftsService) {}

  @Get('current') @RequirePermission('shift:read') @ResponseMessage('Current cashier shift fetched successfully')
  current(@Ctx() ctx: RequestCtx) { return this.shifts.current(ctx); }

  @Post() @RequirePermission('shift:manage') @ResponseMessage('Cashier shift opened successfully')
  open(@Ctx() ctx: RequestCtx, @Body() body: OpenShiftDto) { return this.shifts.open(ctx, body.openingCash); }

  @Get('report') @RequirePermission('report:read') @ResponseMessage('Cashier shift report fetched successfully')
  report(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.shifts.report(ctx, q); }

  @Get(':id') @RequirePermission('shift:read') @ResponseMessage('Cashier shift fetched successfully')
  get(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.shifts.get(ctx, id); }

  @Post(':id/adjustments') @RequirePermission('shift:manage') @ResponseMessage('Cash adjustment recorded successfully')
  adjust(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: ShiftAdjustmentDto) {
    return this.shifts.adjust(ctx, id, body.direction, body.amount, body.reason);
  }

  @Post(':id/close') @RequirePermission('shift:manage') @ResponseMessage('Cashier shift closed successfully')
  async close(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: CloseShiftDto) {
    await this.shifts.close(ctx, id, body.countedCash);
  }
}
