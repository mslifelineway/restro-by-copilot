import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateNested, IsArray, ArrayMaxSize, ArrayUnique } from 'class-validator';
import { Type } from 'class-transformer';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { RequestCtx } from '../common/request-context';
import { INVENTORY_UNITS, InventoryService, STOCK_REASONS, StockReason } from './inventory.service';

const QUANTITY_PATTERN = /^(0|[1-9]\d{0,14})(\.\d{1,3})?$/;
const POSITIVE_QUANTITY_PATTERN = /^(?:0*[1-9]\d{0,14}(?:\.\d{1,3})?|0*\.\d{1,3})$/;

class CreateInventoryItemDto {
  @IsString() @Length(2, 100) name!: string;
  @IsIn(INVENTORY_UNITS) baseUnit!: (typeof INVENTORY_UNITS)[number];
  @Matches(QUANTITY_PATTERN) reorderLevel!: string;
}

class RecordStockMovementDto {
  @IsIn(['IN', 'OUT']) direction!: 'IN' | 'OUT';
  @Matches(POSITIVE_QUANTITY_PATTERN) quantity!: string;
  @IsIn(STOCK_REASONS) reason!: StockReason;
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

class RecipeEntryDto {
  @IsUUID() inventoryItemId!: string;
  @Matches(POSITIVE_QUANTITY_PATTERN) quantity!: string;
}

class SetRecipeDto {
  @IsArray() @ArrayMaxSize(100) @ArrayUnique((entry: RecipeEntryDto) => entry.inventoryItemId)
  @ValidateNested({ each: true }) @Type(() => RecipeEntryDto) ingredients!: RecipeEntryDto[];
}

@TenantOnly()
@Controller('v1/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('items') @RequirePermission('inventory:read') @ResponseMessage('Inventory items fetched successfully')
  list(@Ctx() ctx: RequestCtx) { return this.inventory.list(ctx); }

  @Post('items') @RequirePermission('inventory:adjust') @ResponseMessage('Inventory item created successfully')
  create(@Ctx() ctx: RequestCtx, @Body() body: CreateInventoryItemDto) { return this.inventory.create(ctx, body); }

  @Post('items/:id/movements') @RequirePermission('inventory:adjust') @ResponseMessage('Stock movement recorded successfully')
  movement(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecordStockMovementDto) {
    return this.inventory.recordMovement(ctx, id, body.direction, body.quantity, body.reason, body.reference);
  }

  @Get('items/:id/movements') @RequirePermission('inventory:read') @ResponseMessage('Stock movements fetched successfully')
  movements(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.inventory.listMovements(ctx, id); }

  @Get('recipes/:menuItemId') @RequirePermission('inventory:read') @ResponseMessage('Menu recipe fetched successfully')
  recipe(@Ctx() ctx: RequestCtx, @Param('menuItemId', ParseUUIDPipe) id: string) { return this.inventory.getRecipe(ctx, id); }

  @Put('recipes/:menuItemId') @RequirePermission('inventory:adjust') @ResponseMessage('Menu recipe updated successfully')
  setRecipe(@Ctx() ctx: RequestCtx, @Param('menuItemId', ParseUUIDPipe) id: string, @Body() body: SetRecipeDto) {
    return this.inventory.setRecipe(ctx, id, body.ingredients);
  }
}
