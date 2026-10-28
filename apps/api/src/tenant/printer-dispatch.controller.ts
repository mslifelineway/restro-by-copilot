import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { RequestCtx } from '../common/request-context';
import { PrinterDispatchService } from './printer-dispatch.service';

class CreatePrinterStationDto {
  @Matches(/^[A-Z0-9_-]{1,20}$/) code!: string;
  @IsString() @Length(2, 80) name!: string;
}

class StationCategoriesDto {
  @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID(undefined, { each: true }) categoryIds!: string[];
}

class ClaimJobsQuery {
  @IsOptional() @IsInt() @Min(1) @Max(50) limit = 10;
}

class PrintJobStatusDto {
  @Matches(/^(PRINTED|FAILED)$/) status!: 'PRINTED' | 'FAILED';
  @IsOptional() @IsString() @MaxLength(500) error?: string;
}

@TenantOnly()
@Controller('v1/printer')
export class PrinterDispatchController {
  constructor(private readonly dispatch: PrinterDispatchService) {}

  @Get('stations') @RequirePermission('printer:manage') @ResponseMessage('Printer stations fetched successfully')
  stations(@Ctx() ctx: RequestCtx) { return this.dispatch.listStations(ctx); }

  @Post('stations') @RequirePermission('printer:manage') @ResponseMessage('Printer station created successfully')
  createStation(@Ctx() ctx: RequestCtx, @Body() body: CreatePrinterStationDto) { return this.dispatch.createStation(ctx, body); }

  @Put('stations/:id/categories') @RequirePermission('printer:manage') @ResponseMessage('Printer station routing updated successfully')
  async setCategories(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: StationCategoriesDto) {
    await this.dispatch.setCategories(ctx, id, body.categoryIds);
  }

  @Post('stations/:id/jobs/claim') @RequirePermission('printer:read') @ResponseMessage('Print jobs claimed successfully')
  claim(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Query() query: ClaimJobsQuery) {
    return this.dispatch.claim(ctx, id, query.limit);
  }

  @Put('jobs/:id/status') @RequirePermission('printer:read') @ResponseMessage('Print job status recorded successfully')
  async acknowledge(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: PrintJobStatusDto) {
    await this.dispatch.acknowledge(ctx, id, body.status, body.error);
  }

  @Post('jobs/:id/retry') @RequirePermission('printer:manage') @ResponseMessage('Failed print job queued for retry')
  async retry(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.dispatch.retry(ctx, id); }
}
