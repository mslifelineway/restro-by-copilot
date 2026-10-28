import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { SyncService } from './sync.service';

class SyncEventDto {
  @IsString() @Matches(/^[1-9]\d{0,18}$/) deviceSeq!: string;
  @IsUUID() eventId!: string;
  @IsString() @Matches(/^[A-Z][A-Z0-9_]{0,63}$/) eventType!: string;
  @IsString() @Length(1, 40) occurredAt!: string;
  @IsObject() payload!: Record<string, unknown>;
}

class SyncPushDto {
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SyncEventDto)
  events!: SyncEventDto[];
}

class SyncPullQuery {
  @IsOptional() @IsString() @Matches(/^(0|[1-9]\d{0,18})$/) since = '0';
}

class ResolveSyncEventDto {
  @IsIn(['RESOLVED', 'REJECTED']) status!: 'RESOLVED' | 'REJECTED';
  @IsString() @Length(3, 500) note!: string;
}

class SyncEventListQuery extends PaginationQuery {
  @IsOptional() @IsIn(['RECEIVED', 'RESOLVED', 'REJECTED']) status?: 'RECEIVED' | 'RESOLVED' | 'REJECTED';
}

@TenantOnly()
@Controller('v1/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push') @RequirePermission('sync:push') @ResponseMessage('Offline events uploaded successfully')
  push(@Ctx() ctx: RequestCtx, @Body() body: SyncPushDto) { return this.sync.push(ctx, body.events); }

  @Get('pull') @RequirePermission('sync:pull') @ResponseMessage('Offline changes fetched successfully')
  pull(@Ctx() ctx: RequestCtx, @Query() q: SyncPullQuery) { return this.sync.pull(ctx, q.since); }

  @Get('events') @RequirePermission('device:manage') @ResponseMessage('Offline event inbox fetched successfully')
  events(@Ctx() ctx: RequestCtx, @Query() q: SyncEventListQuery) { return this.sync.events(ctx, q); }

  @Post('events/:id/resolve') @RequirePermission('device:manage') @ResponseMessage('Offline event resolved successfully')
  resolve(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: ResolveSyncEventDto) {
    return this.sync.resolve(ctx, id, body.status, body.note);
  }
}
