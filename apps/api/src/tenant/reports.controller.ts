import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, Matches } from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { RequestCtx } from '../common/request-context';
import { ReportsService } from './reports.service';

class DailySalesQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

@TenantOnly()
@Controller('v1/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily-sales') @RequirePermission('report:read') @ResponseMessage('Daily sales report fetched successfully')
  dailySales(@Ctx() ctx: RequestCtx, @Query() query: DailySalesQuery) {
    return this.reports.dailySales(ctx, query.date);
  }
}
