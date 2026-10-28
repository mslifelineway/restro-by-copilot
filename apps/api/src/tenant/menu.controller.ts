import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID,
  Length, Max, MaxLength, Min, Matches,
} from 'class-validator';
import { Ctx, RequirePermission, ResponseMessage, TenantOnly } from '../common/decorators';
import { PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { MenuCatalogService } from './menu-catalog.service';
import { MenuBulkService } from './menu-bulk.service';
import { MenuService } from './menu.service';

const PRICE_PATTERN = /^(0|[1-9]\d{0,18})$/;

class CreateMenuItemDto {
  @IsUUID() categoryId!: string;
  @IsUUID() taxSlabId!: string;
  @IsString() @Length(2, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 1000) description?: string;
  @IsIn(['VEG', 'NON_VEG', 'EGG']) dietaryType!: 'VEG' | 'NON_VEG' | 'EGG';
  @IsOptional() @IsBoolean() isAvailable?: boolean;
  @IsOptional() @IsString() @Length(1, 80) sku?: string;
}

class UpdateMenuItemDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() taxSlabId?: string;
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 1000) description?: string;
  @IsOptional() @IsIn(['VEG', 'NON_VEG', 'EGG']) dietaryType?: 'VEG' | 'NON_VEG' | 'EGG';
  @IsOptional() @IsBoolean() isAvailable?: boolean;
  @IsOptional() @IsString() @Length(1, 80) sku?: string;
}

class CreateVariantDto {
  @IsString() @Length(1, 80) name!: string;
  @Matches(PRICE_PATTERN) basePrice!: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class UpdateVariantDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @Matches(PRICE_PATTERN) basePrice?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class CreateAddOnGroupDto {
  @IsString() @Length(2, 100) name!: string;
  @IsInt() @Min(0) @Max(100) minSelection!: number;
  @IsInt() @Min(1) @Max(100) maxSelection!: number;
  @IsBoolean() isMandatory!: boolean;
}

class UpdateAddOnGroupDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) minSelection?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxSelection?: number;
  @IsOptional() @IsBoolean() isMandatory?: boolean;
}

class CreateAddOnDto {
  @IsString() @Length(1, 100) name!: string;
  @Matches(PRICE_PATTERN) price!: string;
}

class UpdateAddOnDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @Matches(PRICE_PATTERN) price?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ItemAddOnGroupsDto {
  @IsArray() @ArrayMaxSize(30) @IsUUID(undefined, { each: true }) groupIds!: string[];
}

class VariantPriceDto {
  @Matches(PRICE_PATTERN) price!: string;
}

class ChannelVariantPriceDto extends VariantPriceDto {
  @IsIn(['DINE_IN', 'TAKEAWAY', 'DELIVERY']) channel!: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
}

class MenuPriceQuery {
  @IsOptional() @IsIn(['DINE_IN', 'TAKEAWAY', 'DELIVERY']) channel?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
}

class CreateCategoryDto {
  @IsString() @Length(2, 100) name!: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
}

class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CreateTaxSlabDto {
  @Matches(/^[A-Z0-9_-]{2,30}$/) code!: string;
  @IsInt() @Min(0) @Max(10000) cgstRate!: number;
  @IsInt() @Min(0) @Max(10000) sgstRate!: number;
  @IsInt() @Min(0) @Max(10000) igstRate!: number;
  @IsDateString() effectiveFrom!: string;
}

class ImportMenuCsvDto {
  @IsString() @Length(1) @MaxLength(90000) csv!: string;
}

class UpdateTaxSlabDto {
  @IsOptional() @Matches(/^[A-Z0-9_-]{2,30}$/) code?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10000) cgstRate?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sgstRate?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) igstRate?: number;
  @IsOptional() @IsDateString() effectiveFrom?: string;
}

@TenantOnly()
@Controller('v1')
export class MenuController {
  constructor(private svc: MenuService, private catalog: MenuCatalogService, private bulk: MenuBulkService) {}

  @Get('menu/export') @RequirePermission('menu:read') @ResponseMessage('Menu CSV exported successfully')
  exportCsv(@Ctx() ctx: RequestCtx) { return this.bulk.exportCsv(ctx); }

  @Post('menu/import') @RequirePermission('menu:edit') @ResponseMessage('Menu CSV imported successfully')
  importCsv(@Ctx() ctx: RequestCtx, @Body() b: ImportMenuCsvDto) { return this.bulk.importCsv(ctx, b.csv); }

  @Get('menu/items') @RequirePermission('menu:read') @ResponseMessage('Menu items fetched successfully')
  items(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.catalog.listItems(ctx, q); }

  @Post('menu/items') @RequirePermission('menu:edit') @ResponseMessage('Menu item created successfully')
  createItem(@Ctx() ctx: RequestCtx, @Body() b: CreateMenuItemDto) { return this.catalog.createItem(ctx, b); }

  @Patch('menu/items/:id') @RequirePermission('menu:edit') @ResponseMessage('Menu item updated successfully')
  async updateItem(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateMenuItemDto) {
    await this.catalog.updateItem(ctx, id, b);
  }

  @Delete('menu/items/:id') @RequirePermission('menu:edit') @ResponseMessage('Menu item deleted successfully')
  async deleteItem(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.catalog.deleteItem(ctx, id); }

  @Get('menu/items/:id/variants') @RequirePermission('menu:read') @ResponseMessage('Menu item variants fetched successfully')
  variants(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.catalog.listVariants(ctx, id); }

  @Post('menu/items/:id/variants') @RequirePermission('menu:edit_price') @ResponseMessage('Menu item variant created successfully')
  createVariant(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: CreateVariantDto) {
    return this.catalog.createVariant(ctx, id, b);
  }

  @Patch('menu/variants/:id') @RequirePermission('menu:edit_price') @ResponseMessage('Menu item variant updated successfully')
  async updateVariant(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateVariantDto) {
    await this.catalog.updateVariant(ctx, id, b);
  }

  @Delete('menu/variants/:id') @RequirePermission('menu:edit') @ResponseMessage('Menu item variant deleted successfully')
  async deleteVariant(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.catalog.deleteVariant(ctx, id); }

  @Get('menu/add-on-groups') @RequirePermission('menu:read') @ResponseMessage('Add-on groups fetched successfully')
  addOnGroups(@Ctx() ctx: RequestCtx) { return this.catalog.listAddOnGroups(ctx); }

  @Post('menu/add-on-groups') @RequirePermission('menu:edit') @ResponseMessage('Add-on group created successfully')
  createAddOnGroup(@Ctx() ctx: RequestCtx, @Body() b: CreateAddOnGroupDto) { return this.catalog.createAddOnGroup(ctx, b); }

  @Patch('menu/add-on-groups/:id') @RequirePermission('menu:edit') @ResponseMessage('Add-on group updated successfully')
  async updateAddOnGroup(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateAddOnGroupDto) {
    await this.catalog.updateAddOnGroup(ctx, id, b);
  }

  @Delete('menu/add-on-groups/:id') @RequirePermission('menu:edit') @ResponseMessage('Add-on group deleted successfully')
  async deleteAddOnGroup(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.catalog.deleteAddOnGroup(ctx, id); }

  @Get('menu/add-on-groups/:id/add-ons') @RequirePermission('menu:read') @ResponseMessage('Add-ons fetched successfully')
  addOns(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { return this.catalog.listAddOns(ctx, id); }

  @Post('menu/add-on-groups/:id/add-ons') @RequirePermission('menu:edit_price') @ResponseMessage('Add-on created successfully')
  createAddOn(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: CreateAddOnDto) {
    return this.catalog.createAddOn(ctx, id, b);
  }

  @Patch('menu/add-ons/:id') @RequirePermission('menu:edit_price') @ResponseMessage('Add-on updated successfully')
  async updateAddOn(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateAddOnDto) {
    await this.catalog.updateAddOn(ctx, id, b);
  }

  @Delete('menu/add-ons/:id') @RequirePermission('menu:edit') @ResponseMessage('Add-on deleted successfully')
  async deleteAddOn(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.catalog.deleteAddOn(ctx, id); }

  @Put('menu/items/:id/add-on-groups') @RequirePermission('menu:edit') @ResponseMessage('Menu item add-on groups updated successfully')
  async setItemAddOnGroups(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: ItemAddOnGroupsDto) {
    await this.catalog.setItemAddOnGroups(ctx, id, b.groupIds);
  }

  @Get('menu/items/:id/add-on-groups') @RequirePermission('menu:read') @ResponseMessage('Menu item add-on groups fetched successfully')
  itemAddOnGroups(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.listItemAddOnGroups(ctx, id);
  }

  @Get('menu/variants/:id/price') @RequirePermission('menu:read') @ResponseMessage('Menu variant price fetched successfully')
  resolvePrice(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Query() q: MenuPriceQuery) {
    return this.catalog.resolvePrice(ctx, id, q.channel);
  }

  @Put('menu/variants/:id/price') @RequirePermission('menu:edit_price') @ResponseMessage('Outlet variant price updated successfully')
  async setOutletPrice(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: VariantPriceDto) {
    await this.catalog.setOutletPrice(ctx, id, b.price);
  }

  @Put('menu/variants/:id/channel-price') @RequirePermission('menu:edit_price') @ResponseMessage('Channel variant price updated successfully')
  async setChannelPrice(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: ChannelVariantPriceDto) {
    await this.catalog.setChannelPrice(ctx, id, b.channel, b.price);
  }

  @Get('menu/categories') @RequirePermission('menu:read') @ResponseMessage('Menu categories fetched successfully')
  categories(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.svc.listCategories(ctx, q); }

  @Post('menu/categories') @RequirePermission('menu:edit') @ResponseMessage('Menu category created successfully')
  createCategory(@Ctx() ctx: RequestCtx, @Body() b: CreateCategoryDto) { return this.svc.createCategory(ctx, b); }

  @Patch('menu/categories/:id') @RequirePermission('menu:edit') @ResponseMessage('Menu category updated successfully')
  async updateCategory(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateCategoryDto) {
    await this.svc.updateCategory(ctx, id, b);
  }

  @Delete('menu/categories/:id') @RequirePermission('menu:edit') @ResponseMessage('Menu category deleted successfully')
  async deleteCategory(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.svc.deleteCategory(ctx, id); }

  @Get('tax-slabs') @RequirePermission('menu:read') @ResponseMessage('Tax slabs fetched successfully')
  taxSlabs(@Ctx() ctx: RequestCtx, @Query() q: PaginationQuery) { return this.svc.listTaxSlabs(ctx, q); }

  @Post('tax-slabs') @RequirePermission('menu:edit') @ResponseMessage('Tax slab created successfully')
  createTaxSlab(@Ctx() ctx: RequestCtx, @Body() b: CreateTaxSlabDto) { return this.svc.createTaxSlab(ctx, b); }

  @Patch('tax-slabs/:id') @RequirePermission('menu:edit') @ResponseMessage('Tax slab updated successfully')
  async updateTaxSlab(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string, @Body() b: UpdateTaxSlabDto) {
    await this.svc.updateTaxSlab(ctx, id, b);
  }

  @Delete('tax-slabs/:id') @RequirePermission('menu:edit') @ResponseMessage('Tax slab deleted successfully')
  async deleteTaxSlab(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) { await this.svc.deleteTaxSlab(ctx, id); }
}
