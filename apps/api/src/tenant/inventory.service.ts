import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { drizzlePgErrorCode } from '../db/drizzle-errors';
import { inventoryItems, menuRecipes, stockLedger } from '../db/schema/inventory';

export const INVENTORY_UNITS = ['KG', 'G', 'L', 'ML', 'EA', 'UNIT'] as const;
export const STOCK_REASONS = ['RECEIPT', 'ADJUSTMENT', 'WASTE', 'CONSUMPTION', 'RETURN'] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];
export type StockReason = (typeof STOCK_REASONS)[number];

type ItemInput = { name: string; baseUnit: InventoryUnit; reorderLevel: string };

function toMilli(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

function fromMilli(value: string | bigint) {
  const milli = BigInt(value);
  const sign = milli < 0n ? '-' : '';
  const absolute = milli < 0n ? -milli : milli;
  const whole = absolute / 1000n;
  const fraction = String(absolute % 1000n).padStart(3, '0');
  return `${sign}${whole}.${fraction}`;
}

@Injectable()
export class InventoryService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage inventory');
    return ctx.outletId;
  }

  async list(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT i.id, i.name, i.base_unit AS "baseUnit",
                i.reorder_level_milli::text AS "reorderLevelMilli",
                COALESCE(sum(l.quantity_delta_milli), 0)::text AS "onHandMilli",
                i.version
           FROM inventory_items i
           LEFT JOIN stock_ledger l ON l.inventory_item_id = i.id
          WHERE i.outlet_id = $1 AND i.deleted_at IS NULL
          GROUP BY i.id ORDER BY i.name`,
        [outletId],
      );
      return rows.map((row) => ({
        ...row,
        reorderLevel: fromMilli(row.reorderLevelMilli),
        onHand: fromMilli(row.onHandMilli),
      }));
    });
  }

  async create(ctx: RequestCtx, input: ItemInput) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      try {
        const [item] = await drizzle(c).insert(inventoryItems).values({
          tenantId: ctx.tenantId!, outletId, name: input.name, baseUnit: input.baseUnit,
          reorderLevelMilli: toMilli(input.reorderLevel),
        }).returning({
          id: inventoryItems.id, name: inventoryItems.name, baseUnit: inventoryItems.baseUnit,
        });
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'inventory.item.create', entity: 'inventory_item', entityId: item.id,
        });
        return { ...item, reorderLevel: input.reorderLevel, onHand: '0.000' };
      } catch (error) {
        if (drizzlePgErrorCode(error) === '23505') {
          throw new AppException(HttpStatus.CONFLICT, 'INVENTORY_ITEM_NAME_TAKEN', 'An inventory item with this name already exists at this outlet');
        }
        throw error;
      }
    });
  }

  async recordMovement(ctx: RequestCtx, itemId: string, direction: 'IN' | 'OUT', quantity: string, reason: StockReason, reference?: string) {
    const outletId = this.outletId(ctx);
    const magnitude = toMilli(quantity);
    if (magnitude <= 0n) throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_STOCK_QUANTITY', 'Stock quantity must be greater than zero');
    if ((direction === 'IN' && ['WASTE', 'CONSUMPTION'].includes(reason))
      || (direction === 'OUT' && ['RECEIPT', 'RETURN'].includes(reason))) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'STOCK_REASON_DIRECTION_MISMATCH', 'Stock movement reason does not match its direction');
    }
    const delta = direction === 'IN' ? magnitude : -magnitude;
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [item] = await tx.select({ id: inventoryItems.id })
        .from(inventoryItems).where(and(
          eq(inventoryItems.id, itemId), eq(inventoryItems.outletId, outletId), isNull(inventoryItems.deletedAt),
        )).for('update').limit(1);
      if (!item) throw new AppException(HttpStatus.NOT_FOUND, 'INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found');
      const balance = (await c.query(
        'SELECT COALESCE(sum(quantity_delta_milli), 0)::text AS milli FROM stock_ledger WHERE inventory_item_id = $1',
        [itemId],
      )).rows[0].milli;
      if (BigInt(balance) + delta < 0n) {
        throw new AppException(HttpStatus.CONFLICT, 'INSUFFICIENT_STOCK', 'Stock movement would make the on-hand balance negative');
      }
      const [movement] = await tx.insert(stockLedger).values({
        tenantId: ctx.tenantId!, outletId, inventoryItemId: itemId,
        quantityDeltaMilli: delta, reason, reference: reference ?? null, recordedBy: ctx.userId,
      }).returning({ id: stockLedger.id, createdAt: stockLedger.createdAt });
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'inventory.stock.movement', entity: 'stock_ledger', entityId: movement.id,
        meta: { itemId, direction, quantity, reason, reference: reference ?? null },
      });
      return { ...movement, itemId, delta: fromMilli(delta), onHand: fromMilli(BigInt(balance) + delta), reason };
    });
  }

  async listMovements(ctx: RequestCtx, itemId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const item = await c.query('SELECT 1 FROM inventory_items WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL', [itemId, outletId]);
      if (!item.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'INVENTORY_ITEM_NOT_FOUND', 'Inventory item not found');
      const { rows } = await c.query(
        `SELECT id, quantity_delta_milli::text AS "quantityDeltaMilli", reason, reference,
                created_at AS "createdAt"
           FROM stock_ledger WHERE inventory_item_id = $1 ORDER BY created_at DESC, id DESC`,
        [itemId],
      );
      return rows.map((row) => ({
        ...row,
        quantityDelta: fromMilli(row.quantityDeltaMilli),
        direction: BigInt(row.quantityDeltaMilli) > 0n ? 'IN' : 'OUT',
      }));
    });
  }

  async setRecipe(ctx: RequestCtx, menuItemId: string, entries: Array<{ inventoryItemId: string; quantity: string }>) {
    const outletId = this.outletId(ctx);
    const uniqueIds = entries.map((entry) => entry.inventoryItemId);
    if (new Set(uniqueIds).size !== uniqueIds.length) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'DUPLICATE_RECIPE_ITEM', 'An inventory item may appear only once in a recipe');
    }
    if (entries.some((entry) => toMilli(entry.quantity) <= 0n)) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_RECIPE_QUANTITY', 'Recipe quantities must be greater than zero');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const menuItem = await c.query(
        `SELECT 1 FROM menu_items m JOIN categories cat ON cat.id = m.category_id
          WHERE m.id = $1 AND cat.outlet_id = $2 AND cat.deleted_at IS NULL AND m.deleted_at IS NULL`,
        [menuItemId, outletId],
      );
      if (!menuItem.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'MENU_ITEM_NOT_FOUND', 'Menu item not found at this outlet');
      if (entries.length) {
        const found = await c.query(
          `SELECT id FROM inventory_items WHERE id = ANY($1::uuid[]) AND outlet_id = $2 AND deleted_at IS NULL`,
          [uniqueIds, outletId],
        );
        if (found.rowCount !== entries.length) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'INVENTORY_ITEM_NOT_FOUND', 'One or more recipe ingredients are unavailable at this outlet');
        }
      }
      await drizzle(c).delete(menuRecipes).where(and(
        eq(menuRecipes.menuItemId, menuItemId), eq(menuRecipes.outletId, outletId),
      ));
      for (const entry of entries) {
        await drizzle(c).insert(menuRecipes).values({
          tenantId: ctx.tenantId!, outletId, menuItemId, inventoryItemId: entry.inventoryItemId,
          quantityMilli: toMilli(entry.quantity),
        });
      }
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'inventory.recipe.set', entity: 'menu_item', entityId: menuItemId,
        meta: { ingredientCount: entries.length },
      });
      return { menuItemId, ingredients: entries.map((entry) => ({ ...entry, quantity: fromMilli(toMilli(entry.quantity)) })) };
    });
  }

  async getRecipe(ctx: RequestCtx, menuItemId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const menuItem = await c.query(
        `SELECT 1 FROM menu_items m JOIN categories cat ON cat.id = m.category_id
          WHERE m.id = $1 AND cat.outlet_id = $2 AND cat.deleted_at IS NULL AND m.deleted_at IS NULL`,
        [menuItemId, outletId],
      );
      if (!menuItem.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'MENU_ITEM_NOT_FOUND', 'Menu item not found at this outlet');
      const rows = await drizzle(c).select({
        inventoryItemId: menuRecipes.inventoryItemId,
        name: inventoryItems.name,
        baseUnit: inventoryItems.baseUnit,
        quantityMilli: sql<string>`${menuRecipes.quantityMilli}::text`,
      }).from(menuRecipes).innerJoin(inventoryItems, eq(inventoryItems.id, menuRecipes.inventoryItemId))
        .where(and(eq(menuRecipes.menuItemId, menuItemId), eq(menuRecipes.outletId, outletId), isNull(menuRecipes.deletedAt)))
        .orderBy(asc(inventoryItems.name));
      return rows.map((row) => ({ ...row, quantity: fromMilli(row.quantityMilli) }));
    });
  }
}
