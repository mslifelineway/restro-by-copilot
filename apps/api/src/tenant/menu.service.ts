import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { Page, PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';

const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

@Injectable()
export class MenuService {
  constructor(private db: DbService, private audit: AuditService) {}

  private actor(ctx: RequestCtx) {
    return { tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user' as const };
  }

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage menu categories');
    return ctx.outletId;
  }

  listCategories(ctx: RequestCtx, q: PaginationQuery) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      if (!(await c.query('SELECT 1 FROM outlets WHERE id = $1 AND deleted_at IS NULL', [outletId])).rowCount) {
        throw new AppException(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', 'Outlet not found');
      }
      const total = (await c.query(
        'SELECT count(*)::int AS n FROM categories WHERE outlet_id = $1 AND deleted_at IS NULL',
        [outletId],
      )).rows[0].n;
      const rows = (await c.query(
        `SELECT id, name, sort_order AS "sortOrder", is_active AS "isActive", created_at AS "createdAt"
           FROM categories WHERE outlet_id = $1 AND deleted_at IS NULL
          ORDER BY sort_order, name LIMIT $2 OFFSET $3`,
        [outletId, q.limit, q.offset],
      )).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }

  async createCategory(ctx: RequestCtx, input: { name: string; sortOrder?: number }) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      if (!(await c.query('SELECT 1 FROM outlets WHERE id = $1 AND deleted_at IS NULL', [outletId])).rowCount) {
        throw new AppException(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', 'Outlet not found');
      }
      let row;
      try {
        row = (await c.query(
          `INSERT INTO categories (tenant_id, outlet_id, name, sort_order)
           VALUES ($1,$2,$3,$4) RETURNING id, name, sort_order AS "sortOrder", is_active AS "isActive"`,
          [ctx.tenantId, outletId, input.name, input.sortOrder ?? 0],
        )).rows[0];
      } catch (e) {
        if (isUnique(e)) throw new AppException(HttpStatus.CONFLICT, 'CATEGORY_NAME_TAKEN', 'A category with this name already exists at this outlet');
        throw e;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.category.create', entity: 'category', entityId: row.id });
      return row;
    });
  }

  async updateCategory(ctx: RequestCtx, id: string, patch: { name?: string; sortOrder?: number; isActive?: boolean }) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      try {
        const row = await c.query(
          `UPDATE categories SET name = COALESCE($3,name), sort_order = COALESCE($4,sort_order),
                                 is_active = COALESCE($5,is_active)
            WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL RETURNING id`,
          [id, outletId, patch.name, patch.sortOrder, patch.isActive],
        );
        if (!row.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'CATEGORY_NOT_FOUND', 'Menu category not found');
      } catch (e) {
        if (isUnique(e)) throw new AppException(HttpStatus.CONFLICT, 'CATEGORY_NAME_TAKEN', 'A category with this name already exists at this outlet');
        throw e;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.category.update', entity: 'category', entityId: id, meta: patch });
    });
  }

  async deleteCategory(ctx: RequestCtx, id: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      if ((await c.query('SELECT 1 FROM menu_items WHERE category_id = $1 AND deleted_at IS NULL LIMIT 1', [id])).rowCount) {
        throw new AppException(HttpStatus.CONFLICT, 'CATEGORY_IN_USE', 'Move or delete the menu items before deleting this category');
      }
      const row = await c.query(
        `UPDATE categories SET deleted_at = now(), is_active = false
          WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL RETURNING id`,
        [id, outletId],
      );
      if (!row.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'CATEGORY_NOT_FOUND', 'Menu category not found');
      await this.audit.log(c, { ...this.actor(ctx), action: 'menu.category.delete', entity: 'category', entityId: id });
    });
  }

  listTaxSlabs(ctx: RequestCtx, q: PaginationQuery) {
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const total = (await c.query('SELECT count(*)::int AS n FROM tax_slabs WHERE deleted_at IS NULL')).rows[0].n;
      const rows = (await c.query(
        `SELECT id, code, cgst_rate AS "cgstRate", sgst_rate AS "sgstRate", igst_rate AS "igstRate",
                effective_from AS "effectiveFrom", created_at AS "createdAt"
           FROM tax_slabs WHERE deleted_at IS NULL ORDER BY code LIMIT $1 OFFSET $2`,
        [q.limit, q.offset],
      )).rows;
      return new Page(rows, total, q.page, q.limit);
    });
  }

  async createTaxSlab(ctx: RequestCtx, input: { code: string; cgstRate: number; sgstRate: number; igstRate: number; effectiveFrom: string }) {
    this.validateTaxRates(input.cgstRate, input.sgstRate, input.igstRate);
    return this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      let row;
      try {
        row = (await c.query(
          `INSERT INTO tax_slabs (tenant_id, code, cgst_rate, sgst_rate, igst_rate, effective_from)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, code, cgst_rate AS "cgstRate", sgst_rate AS "sgstRate", igst_rate AS "igstRate", effective_from AS "effectiveFrom"`,
          [ctx.tenantId, input.code, input.cgstRate, input.sgstRate, input.igstRate, input.effectiveFrom],
        )).rows[0];
      } catch (e) {
        if (isUnique(e)) throw new AppException(HttpStatus.CONFLICT, 'TAX_SLAB_CODE_TAKEN', 'A tax slab with this code already exists');
        throw e;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'tax_slab.create', entity: 'tax_slab', entityId: row.id });
      return row;
    });
  }

  async updateTaxSlab(ctx: RequestCtx, id: string, patch: { code?: string; cgstRate?: number; sgstRate?: number; igstRate?: number; effectiveFrom?: string }) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      const current = (await c.query(
        `SELECT cgst_rate AS "cgstRate", sgst_rate AS "sgstRate", igst_rate AS "igstRate"
           FROM tax_slabs WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      )).rows[0];
      if (!current) throw new AppException(HttpStatus.NOT_FOUND, 'TAX_SLAB_NOT_FOUND', 'Tax slab not found');
      const cgstRate = patch.cgstRate ?? current.cgstRate;
      const sgstRate = patch.sgstRate ?? current.sgstRate;
      const igstRate = patch.igstRate ?? current.igstRate;
      this.validateTaxRates(cgstRate, sgstRate, igstRate);
      try {
        await c.query(
          `UPDATE tax_slabs SET code = COALESCE($2,code), cgst_rate = $3, sgst_rate = $4,
                                 igst_rate = $5, effective_from = COALESCE($6,effective_from)
            WHERE id = $1`,
          [id, patch.code, cgstRate, sgstRate, igstRate, patch.effectiveFrom],
        );
      } catch (e) {
        if (isUnique(e)) throw new AppException(HttpStatus.CONFLICT, 'TAX_SLAB_CODE_TAKEN', 'A tax slab with this code already exists');
        throw e;
      }
      await this.audit.log(c, { ...this.actor(ctx), action: 'tax_slab.update', entity: 'tax_slab', entityId: id, meta: patch });
    });
  }

  async deleteTaxSlab(ctx: RequestCtx, id: string) {
    await this.db.tx({ tenantId: ctx.tenantId! }, async (c) => {
      if (!(await c.query('SELECT 1 FROM tax_slabs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rowCount) {
        throw new AppException(HttpStatus.NOT_FOUND, 'TAX_SLAB_NOT_FOUND', 'Tax slab not found');
      }
      const outlets = (await c.query('SELECT id FROM outlets WHERE deleted_at IS NULL')).rows as { id: string }[];
      let inUse = false;
      for (const outlet of outlets) {
        await c.query(`SELECT set_config('app.outlet_id', $1, true)`, [outlet.id]);
        if (
          (await c.query('SELECT 1 FROM menu_items WHERE tax_slab_id = $1 AND deleted_at IS NULL LIMIT 1', [id])).rowCount
          || (await c.query(
            'SELECT 1 FROM outlet_billing_settings WHERE service_charge_tax_slab_id = $1 AND deleted_at IS NULL LIMIT 1',
            [id],
          )).rowCount
        ) {
          inUse = true;
          break;
        }
      }
      await c.query(`SELECT set_config('app.outlet_id', '', true)`);
      if (inUse) {
        throw new AppException(HttpStatus.CONFLICT, 'TAX_SLAB_IN_USE', 'Move or delete menu items and update billing settings before deleting this tax slab');
      }
      const row = await c.query('UPDATE tax_slabs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
      if (!row.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'TAX_SLAB_NOT_FOUND', 'Tax slab not found');
      await this.audit.log(c, { ...this.actor(ctx), action: 'tax_slab.delete', entity: 'tax_slab', entityId: id });
    });
  }

  private validateTaxRates(cgstRate: number, sgstRate: number, igstRate: number) {
    if (cgstRate + sgstRate !== igstRate) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_TAX_RATES', 'IGST rate must equal the sum of CGST and SGST rates');
    }
  }
}
