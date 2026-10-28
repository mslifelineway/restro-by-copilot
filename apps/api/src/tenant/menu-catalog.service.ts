import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { Page, PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';

type Channel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
type DietaryType = 'VEG' | 'NON_VEG' | 'EGG';
type PoolClient = import('pg').PoolClient;
type GroupSelection = { name?: string; minSelection?: number; maxSelection?: number; isMandatory?: boolean };

const isUnique = (error: unknown) => (error as { code?: string }).code === '23505';
const MAX_BIGINT = 9223372036854775807n;

@Injectable()
export class MenuCatalogService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage menu data');
    return ctx.outletId;
  }

  private actor(ctx: RequestCtx) {
    return { tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user' as const };
  }

  private price(value: string) {
    if (BigInt(value) > MAX_BIGINT) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_PRICE', 'Price exceeds the supported integer range');
    }
    return value;
  }

  private async item(c: PoolClient, id: string, outletId: string) {
    const row = (await c.query(
      `SELECT m.id, m.category_id AS "categoryId", m.tax_slab_id AS "taxSlabId"
         FROM menu_items m JOIN categories c ON c.id = m.category_id
        WHERE m.id = $1 AND c.outlet_id = $2 AND c.deleted_at IS NULL AND m.deleted_at IS NULL`,
      [id, outletId],
    )).rows[0];
    if (!row) throw new AppException(HttpStatus.NOT_FOUND, 'MENU_ITEM_NOT_FOUND', 'Menu item not found');
    return row as { id: string; categoryId: string; taxSlabId: string };
  }

  private async assertCategory(c: PoolClient, categoryId: string, outletId: string) {
    if (!(await c.query('SELECT 1 FROM categories WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL', [categoryId, outletId])).rowCount) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'CATEGORY_NOT_FOUND', 'Category is not available at the selected outlet');
    }
  }

  private async assertTaxSlab(c: PoolClient, taxSlabId: string) {
    if (!(await c.query('SELECT 1 FROM tax_slabs WHERE id = $1 AND deleted_at IS NULL', [taxSlabId])).rowCount) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'TAX_SLAB_NOT_FOUND', 'Tax slab not found');
    }
  }

  listItems(ctx: RequestCtx, q: PaginationQuery) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const total = (await c.query(
        `SELECT count(*)::int AS n FROM menu_items m
          JOIN categories c ON c.id = m.category_id
         WHERE c.outlet_id = $1 AND c.deleted_at IS NULL AND m.deleted_at IS NULL`,
        [outletId],
      )).rows[0].n;
      const rows = (await c.query(
        `SELECT m.id, m.category_id AS "categoryId", c.name AS "categoryName", m.tax_slab_id AS "taxSlabId",
                t.code AS "taxCode", m.name, m.description, m.dietary_type AS "dietaryType",
                m.is_available AS "isAvailable", m.sku, m.created_at AS "createdAt"
           FROM menu_items m
           JOIN categories c ON c.id = m.category_id
           JOIN tax_slabs t ON t.id = m.tax_slab_id
          WHERE c.outlet_id = $1 AND c.deleted_at IS NULL AND m.deleted_at IS NULL
          ORDER BY c.sort_order, c.name, m.name LIMIT $2 OFFSET $3`,
        [outletId, q.limit, q.offset],
      )).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }

  async createItem(ctx: RequestCtx, input: {
    categoryId: string; taxSlabId: string; name: string; description?: string;
    dietaryType: DietaryType; isAvailable?: boolean; sku?: string;
  }) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.assertCategory(c, input.categoryId, outletId);
      await this.assertTaxSlab(c, input.taxSlabId);
      let row;
      try {
        row = (await c.query(
          `INSERT INTO menu_items (tenant_id, category_id, tax_slab_id, name, description, dietary_type, is_available, sku)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, category_id AS "categoryId", tax_slab_id AS "taxSlabId", name, description,
                     dietary_type AS "dietaryType", is_available AS "isAvailable", sku`,
          [ctx.tenantId, input.categoryId, input.taxSlabId, input.name, input.description ?? null,
            input.dietaryType, input.isAvailable ?? true, input.sku ?? null],
        )).rows[0];
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'MENU_SKU_TAKEN', 'A menu item with this SKU already exists');
        throw error;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.item.create', entity: 'menu_item', entityId: row.id });
      return row;
    });
  }

  async updateItem(ctx: RequestCtx, id: string, patch: {
    categoryId?: string; taxSlabId?: string; name?: string; description?: string;
    dietaryType?: DietaryType; isAvailable?: boolean; sku?: string;
  }) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const current = await this.item(c, id, outletId);
      const categoryId = patch.categoryId ?? current.categoryId;
      const taxSlabId = patch.taxSlabId ?? current.taxSlabId;
      await this.assertCategory(c, categoryId, outletId);
      await this.assertTaxSlab(c, taxSlabId);
      try {
        await c.query(
          `UPDATE menu_items SET category_id = $2, tax_slab_id = $3, name = COALESCE($4,name),
                                 description = COALESCE($5,description), dietary_type = COALESCE($6,dietary_type),
                                 is_available = COALESCE($7,is_available), sku = COALESCE($8,sku)
            WHERE id = $1`,
          [id, categoryId, taxSlabId, patch.name, patch.description, patch.dietaryType, patch.isAvailable, patch.sku],
        );
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'MENU_SKU_TAKEN', 'A menu item with this SKU already exists');
        throw error;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.item.update', entity: 'menu_item', entityId: id, meta: patch });
    });
  }

  async deleteItem(ctx: RequestCtx, id: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.item(c, id, outletId);
      await c.query('UPDATE menu_items SET deleted_at = now(), is_available = false WHERE id = $1', [id]);
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.item.delete', entity: 'menu_item', entityId: id });
    });
  }

  listVariants(ctx: RequestCtx, itemId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.item(c, itemId, outletId);
      return (await c.query(
        `SELECT id, name, base_price::text AS "basePrice", is_default AS "isDefault"
           FROM variants WHERE menu_item_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, name`,
        [itemId],
      )).rows;
    });
  }

  async createVariant(ctx: RequestCtx, itemId: string, input: { name: string; basePrice: string; isDefault?: boolean }) {
    const outletId = this.outletId(ctx);
    const price = this.price(input.basePrice);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.item(c, itemId, outletId);
      if (input.isDefault) {
        await c.query('UPDATE variants SET is_default = false WHERE menu_item_id = $1 AND deleted_at IS NULL', [itemId]);
      }
      try {
        const row = (await c.query(
          `INSERT INTO variants (tenant_id, menu_item_id, name, base_price, is_default)
           VALUES ($1,$2,$3,$4::bigint,$5)
           RETURNING id, name, base_price::text AS "basePrice", is_default AS "isDefault"`,
          [ctx.tenantId, itemId, input.name, price, input.isDefault ?? false],
        )).rows[0];
        await this.audit.log(c, { ...this.actor(ctx), action: 'menu.variant.create', entity: 'variant', entityId: row.id });
        return row;
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'VARIANT_CONFLICT', 'Variant name already exists or this item already has a default variant');
        throw error;
      }
    });
  }

  async updateVariant(ctx: RequestCtx, id: string, patch: { name?: string; basePrice?: string; isDefault?: boolean }) {
    const outletId = this.outletId(ctx);
    const price = patch.basePrice === undefined ? undefined : this.price(patch.basePrice);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const current = (await c.query(
        `SELECT v.menu_item_id AS "menuItemId" FROM variants v
          JOIN menu_items m ON m.id = v.menu_item_id
          JOIN categories c ON c.id = m.category_id
         WHERE v.id = $1 AND v.deleted_at IS NULL AND c.outlet_id = $2 AND m.deleted_at IS NULL`,
        [id, outletId],
      )).rows[0];
      if (!current) throw new AppException(HttpStatus.NOT_FOUND, 'VARIANT_NOT_FOUND', 'Menu variant not found');
      if (patch.isDefault) {
        await c.query('UPDATE variants SET is_default = false WHERE menu_item_id = $1 AND id <> $2 AND deleted_at IS NULL', [current.menuItemId, id]);
      }
      try {
        await c.query(
          `UPDATE variants SET name = COALESCE($2,name), base_price = COALESCE($3::bigint,base_price),
                                 is_default = COALESCE($4,is_default)
            WHERE id = $1`,
          [id, patch.name, price ?? null, patch.isDefault],
        );
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'VARIANT_CONFLICT', 'Variant name already exists or this item already has a default variant');
        throw error;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.variant.update', entity: 'variant', entityId: id, meta: { ...patch, basePrice: price } });
    });
  }

  async deleteVariant(ctx: RequestCtx, id: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const row = await c.query(
        `UPDATE variants v SET deleted_at = now(), is_default = false
          FROM menu_items m, categories c
         WHERE v.menu_item_id = m.id AND m.category_id = c.id
           AND v.id = $1 AND v.deleted_at IS NULL AND m.deleted_at IS NULL AND c.outlet_id = $2
         RETURNING v.id`,
        [id, outletId],
      );
      if (!row.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'VARIANT_NOT_FOUND', 'Menu variant not found');
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.variant.delete', entity: 'variant', entityId: id });
    });
  }

  listAddOnGroups(ctx: RequestCtx) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => (await c.query(
      `SELECT g.id, g.name, g.min_selection AS "minSelection", g.max_selection AS "maxSelection",
              g.is_mandatory AS "isMandatory", g.created_at AS "createdAt",
              COALESCE(json_agg(json_build_object('id', a.id, 'name', a.name, 'price', a.price::text, 'isActive', a.is_active))
                FILTER (WHERE a.id IS NOT NULL), '[]') AS "addOns"
         FROM add_on_groups g LEFT JOIN add_ons a ON a.add_on_group_id = g.id AND a.deleted_at IS NULL
        WHERE g.deleted_at IS NULL GROUP BY g.id ORDER BY g.name`,
    )).rows);
  }

  async createAddOnGroup(ctx: RequestCtx, input: { name: string; minSelection: number; maxSelection: number; isMandatory: boolean }) {
    this.validateGroup(input);
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      try {
        const row = (await c.query(
          `INSERT INTO add_on_groups (tenant_id, name, min_selection, max_selection, is_mandatory)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, name, min_selection AS "minSelection", max_selection AS "maxSelection", is_mandatory AS "isMandatory"`,
          [ctx.tenantId, input.name, input.minSelection, input.maxSelection, input.isMandatory],
        )).rows[0];
        await this.audit.log(c, { ...this.actor(ctx), action: 'menu.add_on_group.create', entity: 'add_on_group', entityId: row.id });
        return row;
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'ADD_ON_GROUP_NAME_TAKEN', 'An add-on group with this name already exists');
        throw error;
      }
    });
  }

  async updateAddOnGroup(ctx: RequestCtx, id: string, patch: GroupSelection) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const current = (await c.query(
        `SELECT min_selection AS "minSelection", max_selection AS "maxSelection", is_mandatory AS "isMandatory"
           FROM add_on_groups WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      )).rows[0];
      if (!current) throw new AppException(HttpStatus.NOT_FOUND, 'ADD_ON_GROUP_NOT_FOUND', 'Add-on group not found');
      const next = {
        minSelection: patch.minSelection ?? current.minSelection,
        maxSelection: patch.maxSelection ?? current.maxSelection,
        isMandatory: patch.isMandatory ?? current.isMandatory,
      };
      this.validateGroup(next);
      try {
        await c.query(
          `UPDATE add_on_groups SET name = COALESCE($2,name), min_selection = $3, max_selection = $4, is_mandatory = $5
            WHERE id = $1`,
          [id, patch.name, next.minSelection, next.maxSelection, next.isMandatory],
        );
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'ADD_ON_GROUP_NAME_TAKEN', 'An add-on group with this name already exists');
        throw error;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.add_on_group.update', entity: 'add_on_group', entityId: id, meta: patch });
    });
  }

  async deleteAddOnGroup(ctx: RequestCtx, id: string) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const row = await c.query('UPDATE add_on_groups SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
      if (!row.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'ADD_ON_GROUP_NOT_FOUND', 'Add-on group not found');
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.add_on_group.delete', entity: 'add_on_group', entityId: id });
    });
  }

  listAddOns(ctx: RequestCtx, groupId: string) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      if (!(await c.query('SELECT 1 FROM add_on_groups WHERE id = $1 AND deleted_at IS NULL', [groupId])).rowCount) {
        throw new AppException(HttpStatus.NOT_FOUND, 'ADD_ON_GROUP_NOT_FOUND', 'Add-on group not found');
      }
      return (await c.query(
        `SELECT id, name, price::text AS price, is_active AS "isActive", created_at AS "createdAt"
           FROM add_ons WHERE add_on_group_id = $1 AND deleted_at IS NULL ORDER BY name`,
        [groupId],
      )).rows;
    });
  }

  async createAddOn(ctx: RequestCtx, groupId: string, input: { name: string; price: string }) {
    const price = this.price(input.price);
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      if (!(await c.query('SELECT 1 FROM add_on_groups WHERE id = $1 AND deleted_at IS NULL', [groupId])).rowCount) {
        throw new AppException(HttpStatus.NOT_FOUND, 'ADD_ON_GROUP_NOT_FOUND', 'Add-on group not found');
      }
      try {
        const row = (await c.query(
          `INSERT INTO add_ons (tenant_id, add_on_group_id, name, price) VALUES ($1,$2,$3,$4::bigint)
           RETURNING id, name, price::text AS price, is_active AS "isActive"`,
          [ctx.tenantId, groupId, input.name, price],
        )).rows[0];
        await this.audit.log(c, { ...this.actor(ctx), action: 'menu.add_on.create', entity: 'add_on', entityId: row.id });
        return row;
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'ADD_ON_NAME_TAKEN', 'An add-on with this name already exists in the group');
        throw error;
      }
    });
  }

  async updateAddOn(ctx: RequestCtx, id: string, patch: { name?: string; price?: string; isActive?: boolean }) {
    const price = patch.price === undefined ? undefined : this.price(patch.price);
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      try {
        const row = await c.query(
          `UPDATE add_ons SET name = COALESCE($2,name), price = COALESCE($3::bigint,price),
                              is_active = COALESCE($4,is_active)
            WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
          [id, patch.name, price ?? null, patch.isActive],
        );
        if (!row.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'ADD_ON_NOT_FOUND', 'Add-on not found');
      } catch (error) {
        if (isUnique(error)) throw new AppException(HttpStatus.CONFLICT, 'ADD_ON_NAME_TAKEN', 'An add-on with this name already exists in the group');
        throw error;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.add_on.update', entity: 'add_on', entityId: id, meta: { ...patch, price } });
    });
  }

  async deleteAddOn(ctx: RequestCtx, id: string) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const row = await c.query('UPDATE add_ons SET deleted_at = now(), is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
      if (!row.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'ADD_ON_NOT_FOUND', 'Add-on not found');
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.add_on.delete', entity: 'add_on', entityId: id });
    });
  }

  async setItemAddOnGroups(ctx: RequestCtx, itemId: string, groupIds: string[]) {
    const outletId = this.outletId(ctx);
    if (new Set(groupIds).size !== groupIds.length) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'DUPLICATE_ADD_ON_GROUP', 'An add-on group may only be assigned once');
    }
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.item(c, itemId, outletId);
      if (groupIds.length) {
        const found = await c.query(
          `SELECT id FROM add_on_groups WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [groupIds],
        );
        if (found.rowCount !== groupIds.length) throw new AppException(HttpStatus.BAD_REQUEST, 'ADD_ON_GROUP_NOT_FOUND', 'One or more add-on groups are not available');
      }
      await c.query('DELETE FROM item_add_on_groups WHERE menu_item_id = $1', [itemId]);
      for (let index = 0; index < groupIds.length; index++) {
        await c.query(
          `INSERT INTO item_add_on_groups (tenant_id, menu_item_id, add_on_group_id, sort_order) VALUES ($1,$2,$3,$4)`,
          [ctx.tenantId, itemId, groupIds[index], index],
        );
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.item.set_add_on_groups', entity: 'menu_item', entityId: itemId, meta: { groupIds } });
    });
  }

  listItemAddOnGroups(ctx: RequestCtx, itemId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.item(c, itemId, outletId);
      return (await c.query(
        `SELECT g.id, g.name, g.min_selection AS "minSelection", g.max_selection AS "maxSelection",
                g.is_mandatory AS "isMandatory", iag.sort_order AS "sortOrder",
                COALESCE(json_agg(json_build_object('id', a.id, 'name', a.name, 'price', a.price::text, 'isActive', a.is_active)
                  ORDER BY a.name) FILTER (WHERE a.id IS NOT NULL AND a.is_active), '[]') AS "addOns"
           FROM item_add_on_groups iag
           JOIN add_on_groups g ON g.id = iag.add_on_group_id AND g.deleted_at IS NULL
           LEFT JOIN add_ons a ON a.add_on_group_id = g.id AND a.deleted_at IS NULL
          WHERE iag.menu_item_id = $1
          GROUP BY g.id, iag.sort_order
          ORDER BY iag.sort_order, g.name`,
        [itemId],
      )).rows;
    });
  }

  async resolvePrice(ctx: RequestCtx, variantId: string, channel?: Channel) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const row = (await c.query(
        `SELECT v.id AS "variantId", v.name AS "variantName", v.base_price::text AS "basePrice",
                op.price::text AS "outletPrice", cp.price::text AS "channelPrice",
                CASE WHEN cp.price IS NOT NULL THEN cp.price::text
                     WHEN op.price IS NOT NULL THEN op.price::text
                     ELSE v.base_price::text END AS price,
                CASE WHEN cp.price IS NOT NULL THEN 'channel'
                     WHEN op.price IS NOT NULL THEN 'outlet'
                     ELSE 'base' END AS source
           FROM variants v
           JOIN menu_items m ON m.id = v.menu_item_id
           JOIN categories c ON c.id = m.category_id
           LEFT JOIN outlet_variant_prices op ON op.variant_id = v.id AND op.outlet_id = $2
           LEFT JOIN channel_variant_prices cp ON cp.variant_id = v.id AND cp.outlet_id = $2 AND cp.channel = $3
          WHERE v.id = $1 AND v.deleted_at IS NULL AND m.deleted_at IS NULL
            AND c.outlet_id = $2 AND c.deleted_at IS NULL`,
        [variantId, outletId, channel ?? null],
      )).rows[0];
      if (!row) throw new AppException(HttpStatus.NOT_FOUND, 'VARIANT_NOT_FOUND', 'Menu variant not found');
      return { ...row, channel: channel ?? null };
    });
  }

  async setOutletPrice(ctx: RequestCtx, variantId: string, rawPrice: string) {
    const outletId = this.outletId(ctx);
    const price = this.price(rawPrice);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.assertVariant(c, variantId, outletId);
      await c.query(
        `INSERT INTO outlet_variant_prices (tenant_id, outlet_id, variant_id, price)
         VALUES ($1,$2,$3,$4::bigint)
         ON CONFLICT (outlet_id, variant_id) DO UPDATE SET price = EXCLUDED.price`,
        [ctx.tenantId, outletId, variantId, price],
      );
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.price.set_outlet', entity: 'variant', entityId: variantId, meta: { price } });
    });
  }

  async setChannelPrice(ctx: RequestCtx, variantId: string, channel: Channel, rawPrice: string) {
    const outletId = this.outletId(ctx);
    const price = this.price(rawPrice);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await this.assertVariant(c, variantId, outletId);
      await c.query(
        `INSERT INTO channel_variant_prices (tenant_id, outlet_id, variant_id, channel, price)
         VALUES ($1,$2,$3,$4,$5::bigint)
         ON CONFLICT (outlet_id, variant_id, channel) DO UPDATE SET price = EXCLUDED.price`,
        [ctx.tenantId, outletId, variantId, channel, price],
      );
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.price.set_channel', entity: 'variant', entityId: variantId, meta: { channel, price } });
    });
  }

  private async assertVariant(c: PoolClient, variantId: string, outletId: string) {
    if (!(await c.query(
      `SELECT 1 FROM variants v
        JOIN menu_items m ON m.id = v.menu_item_id
        JOIN categories c ON c.id = m.category_id
       WHERE v.id = $1 AND v.deleted_at IS NULL AND m.deleted_at IS NULL
         AND c.outlet_id = $2 AND c.deleted_at IS NULL`,
      [variantId, outletId],
    )).rowCount) {
      throw new AppException(HttpStatus.NOT_FOUND, 'VARIANT_NOT_FOUND', 'Menu variant not found');
    }
  }

  private validateGroup(group: { minSelection: number; maxSelection: number; isMandatory: boolean }) {
    if (
      group.minSelection > group.maxSelection ||
      group.isMandatory !== (group.minSelection > 0)
    ) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'INVALID_ADD_ON_SELECTION',
        'A mandatory group must require at least one selection, and minimum selection cannot exceed maximum',
      );
    }
  }
}
