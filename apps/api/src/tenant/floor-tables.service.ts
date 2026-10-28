import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { drizzlePgErrorCode } from '../db/drizzle-errors';
import { diningTables } from '../db/schema/dining-tables';

export const TABLE_STATES = ['AVAILABLE', 'IN_USE', 'RESERVED', 'UNAVAILABLE'] as const;
export type TableState = (typeof TABLE_STATES)[number];

type TableInput = { code: string; name: string; section?: string; capacity: number; sortOrder?: number };
type TablePatch = Partial<TableInput>;

const transitions: Record<TableState, TableState[]> = {
  AVAILABLE: ['IN_USE', 'RESERVED', 'UNAVAILABLE'],
  IN_USE: ['AVAILABLE'],
  RESERVED: ['AVAILABLE', 'IN_USE', 'UNAVAILABLE'],
  UNAVAILABLE: ['AVAILABLE'],
};

@Injectable()
export class FloorTablesService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage floor tables');
    return ctx.outletId;
  }

  async list(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT t.id, t.code, t.name, t.section, t.capacity, t.sort_order AS "sortOrder",
                t.merged_order_id AS "mergedOrderId",
                t.state, t.version, active.id AS "activeOrderId",
                active.created_at AS "activeOrderCreatedAt"
           FROM dining_tables t
           LEFT JOIN LATERAL (
             SELECT o.id, o.created_at
               FROM orders o
              WHERE o.tenant_id = t.tenant_id AND o.outlet_id = t.outlet_id
                AND (o.table_id = t.id OR t.merged_order_id = o.id)
                AND o.status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY')
                AND o.deleted_at IS NULL
              ORDER BY o.created_at, o.id
              LIMIT 1
           ) active ON true
          WHERE t.outlet_id = $1 AND t.deleted_at IS NULL
          ORDER BY t.section, t.sort_order, t.code`,
        [outletId],
      );
      return rows;
    });
  }

  async create(ctx: RequestCtx, input: TableInput) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      try {
        const [row] = await drizzle(c).insert(diningTables).values({
          tenantId: ctx.tenantId!,
          outletId,
          code: input.code,
          name: input.name,
          section: input.section ?? '',
          capacity: input.capacity,
          sortOrder: input.sortOrder ?? 0,
          state: 'AVAILABLE',
        }).returning({
          id: diningTables.id,
          code: diningTables.code,
          name: diningTables.name,
          section: diningTables.section,
          capacity: diningTables.capacity,
          sortOrder: diningTables.sortOrder,
          state: diningTables.state,
        });
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'floor.table.create', entity: 'dining_table', entityId: row.id,
        });
        return row;
      } catch (error) {
        if (drizzlePgErrorCode(error) === '23505') {
          throw new AppException(HttpStatus.CONFLICT, 'TABLE_CODE_TAKEN', 'A table with this code already exists at this outlet');
        }
        throw error;
      }
    });
  }

  async update(ctx: RequestCtx, id: string, patch: TablePatch) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      try {
        const updated = await drizzle(c).update(diningTables).set({
          code: patch.code,
          name: patch.name,
          section: patch.section,
          capacity: patch.capacity,
          sortOrder: patch.sortOrder,
        }).where(and(
          eq(diningTables.id, id),
          eq(diningTables.outletId, outletId),
          isNull(diningTables.deletedAt),
        )).returning({ id: diningTables.id });
        if (!updated.length) throw new AppException(HttpStatus.NOT_FOUND, 'TABLE_NOT_FOUND', 'Floor table not found');
      } catch (error) {
        if (drizzlePgErrorCode(error) === '23505') {
          throw new AppException(HttpStatus.CONFLICT, 'TABLE_CODE_TAKEN', 'A table with this code already exists at this outlet');
        }
        throw error;
      }
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'floor.table.update', entity: 'dining_table', entityId: id, meta: patch,
      });
    });
  }

  async setState(ctx: RequestCtx, id: string, next: TableState) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [current] = await tx.select({ state: diningTables.state })
        .from(diningTables)
        .where(and(eq(diningTables.id, id), eq(diningTables.outletId, outletId), isNull(diningTables.deletedAt)))
        .for('update')
        .limit(1);
      if (!current) throw new AppException(HttpStatus.NOT_FOUND, 'TABLE_NOT_FOUND', 'Floor table not found');
      if (current.state === next) return;
      if (!transitions[current.state as TableState]?.includes(next)) {
        throw new AppException(HttpStatus.CONFLICT, 'INVALID_TABLE_STATE_TRANSITION', `Cannot change table state from ${current.state} to ${next}`);
      }
      if (current.state === 'IN_USE' && next === 'AVAILABLE') {
        const activeOrder = await c.query(
          `SELECT 1 FROM orders o
            WHERE o.outlet_id = $2
              AND (o.table_id = $1 OR EXISTS (
                SELECT 1 FROM dining_tables dt WHERE dt.id = $1 AND dt.merged_order_id = o.id
              ))
              AND o.status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY') AND o.deleted_at IS NULL
            LIMIT 1`,
          [id, outletId],
        );
        if (activeOrder.rowCount) throw new AppException(HttpStatus.CONFLICT, 'TABLE_HAS_ACTIVE_ORDER', 'Complete or cancel the active order before releasing this table');
      }
      await tx.update(diningTables).set({ state: next }).where(and(
        eq(diningTables.id, id),
        eq(diningTables.outletId, outletId),
        isNull(diningTables.deletedAt),
      ));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'floor.table.state_change', entity: 'dining_table', entityId: id,
        meta: { from: current.state, to: next },
      });
    });
  }

  async delete(ctx: RequestCtx, id: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [current] = await tx.select({ state: diningTables.state })
        .from(diningTables)
        .where(and(eq(diningTables.id, id), eq(diningTables.outletId, outletId), isNull(diningTables.deletedAt)))
        .for('update')
        .limit(1);
      if (!current) throw new AppException(HttpStatus.NOT_FOUND, 'TABLE_NOT_FOUND', 'Floor table not found');
      if (current.state === 'IN_USE') {
        throw new AppException(HttpStatus.CONFLICT, 'TABLE_IN_USE', 'An in-use table cannot be deleted');
      }
      await tx.update(diningTables).set({ deletedAt: new Date(), state: 'UNAVAILABLE' })
        .where(eq(diningTables.id, id));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'floor.table.delete', entity: 'dining_table', entityId: id,
      });
    });
  }
}
