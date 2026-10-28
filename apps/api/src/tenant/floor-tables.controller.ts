import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min, Matches } from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { RequestCtx } from '../common/request-context';
import { FloorTablesService, TABLE_STATES, TableState } from './floor-tables.service';

class CreateFloorTableDto {
  @Matches(/^[A-Z0-9_-]{1,20}$/) code!: string;
  @IsString() @Length(1, 80) name!: string;
  @IsOptional() @IsString() @Length(0, 80) section?: string;
  @IsInt() @Min(1) @Max(100) capacity!: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}

class UpdateFloorTableDto {
  @IsOptional() @Matches(/^[A-Z0-9_-]{1,20}$/) code?: string;
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @Length(0, 80) section?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) capacity?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}

class SetTableStateDto {
  @IsIn(TABLE_STATES) state!: TableState;
}

@TenantOnly()
@Controller('v1/floor/tables')
export class FloorTablesController {
  constructor(private readonly tables: FloorTablesService) {}

  @Get() @RequirePermission('table:read') @ResponseMessage('Floor tables fetched successfully')
  list(@Ctx() ctx: RequestCtx) { return this.tables.list(ctx); }

  @Post() @RequirePermission('table:manage') @ResponseMessage('Floor table created successfully')
  create(@Ctx() ctx: RequestCtx, @Body() body: CreateFloorTableDto) { return this.tables.create(ctx, body); }

  @Patch(':id') @RequirePermission('table:manage') @ResponseMessage('Floor table updated successfully')
  async update(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateFloorTableDto) {
    await this.tables.update(ctx, id, body);
  }

  @Put(':id/state') @RequirePermission('order:create') @ResponseMessage('Floor table state updated successfully')
  async setState(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetTableStateDto) {
    await this.tables.setState(ctx, id, body.state);
  }

  @Delete(':id') @RequirePermission('table:manage') @ResponseMessage('Floor table deleted successfully')
  async delete(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.tables.delete(ctx, id); }
}
