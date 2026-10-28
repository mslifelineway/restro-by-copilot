import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { Page, PaginationQuery } from '../common/pagination';
import { cashierShiftAdjustments, cashierShifts } from '../db/schema/cashier-shifts';

const MAX_BIGINT = 9223372036854775807n;

@Injectable()
export class CashierShiftsService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage cashier shifts');
    return ctx.outletId;
  }

  async current(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT id, opening_cash::text AS "openingCash", opened_at AS "openedAt"
           FROM cashier_shifts
          WHERE outlet_id = $1 AND user_id = $2 AND status = 'OPEN' AND deleted_at IS NULL
          LIMIT 1`,
        [outletId, ctx.userId],
      );
      return rows[0] ?? null;
    });
  }

  async open(ctx: RequestCtx, openingCash: string) {
    const outletId = this.outletId(ctx);
    if (BigInt(openingCash) > MAX_BIGINT) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'CASH_AMOUNT_TOO_LARGE', 'Cash amount exceeds the supported integer range');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      try {
        const [shift] = await drizzle(c).insert(cashierShifts).values({
          tenantId: ctx.tenantId!, outletId, userId: ctx.userId, openingCash: BigInt(openingCash),
        }).returning({
          id: cashierShifts.id, openingCash: cashierShifts.openingCash,
          status: cashierShifts.status, openedAt: cashierShifts.openedAt,
        });
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'cashier_shift.open', entity: 'cashier_shift', entityId: shift.id,
          meta: { openingCash },
        });
        return { ...shift, openingCash: shift.openingCash.toString() };
      } catch (error) {
        const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
        if (code === '23505') throw new AppException(HttpStatus.CONFLICT, 'CASHIER_SHIFT_ALREADY_OPEN', 'You already have an open cashier shift at this outlet');
        throw error;
      }
    });
  }

  async close(ctx: RequestCtx, shiftId: string, countedCash: string) {
    const outletId = this.outletId(ctx);
    if (BigInt(countedCash) > MAX_BIGINT) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'CASH_AMOUNT_TOO_LARGE', 'Cash amount exceeds the supported integer range');
    }
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT id, opening_cash::text AS "openingCash"
           FROM cashier_shifts
          WHERE id = $1 AND outlet_id = $2 AND user_id = $3 AND status = 'OPEN' AND deleted_at IS NULL
          FOR UPDATE`,
        [shiftId, outletId, ctx.userId],
      );
      if (!rows.length) throw new AppException(HttpStatus.NOT_FOUND, 'OPEN_CASHIER_SHIFT_NOT_FOUND', 'Open cashier shift not found');
      const cashPayments = (await c.query(
        `SELECT (COALESCE((SELECT sum(amount) FROM invoice_payments WHERE shift_id = $1 AND method = 'CASH'), 0)
                  - COALESCE((SELECT sum(amount) FROM invoice_refunds WHERE shift_id = $1 AND method = 'CASH'), 0)
                  + COALESCE((SELECT sum(amount) FROM cashier_shift_adjustments WHERE shift_id = $1 AND direction = 'IN'), 0)
                  - COALESCE((SELECT sum(amount) FROM cashier_shift_adjustments WHERE shift_id = $1 AND direction = 'OUT'), 0))::text AS amount`,
        [shiftId],
      )).rows[0].amount;
      const expected = BigInt(rows[0].openingCash) + BigInt(cashPayments);
      const counted = BigInt(countedCash);
      if (expected > MAX_BIGINT) {
        throw new AppException(HttpStatus.CONFLICT, 'CASH_EXPECTED_AMOUNT_TOO_LARGE', 'Expected cash exceeds the supported integer range');
      }
      const variance = counted - expected;
      await c.query(
        `UPDATE cashier_shifts
            SET status = 'CLOSED', closed_at = now(), expected_cash = $2, counted_cash = $3, variance = $4
          WHERE id = $1`,
        [shiftId, expected.toString(), counted.toString(), variance.toString()],
      );
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'cashier_shift.close', entity: 'cashier_shift', entityId: shiftId,
        meta: { expectedCash: expected.toString(), countedCash, variance: variance.toString() },
      });
    });
  }

  async get(ctx: RequestCtx, shiftId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT id, user_id AS "userId", status, opening_cash::text AS "openingCash",
                expected_cash::text AS "expectedCash", counted_cash::text AS "countedCash",
                variance::text AS variance, opened_at AS "openedAt", closed_at AS "closedAt"
           FROM cashier_shifts
          WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL`,
        [shiftId, outletId],
      );
      if (!rows.length) throw new AppException(HttpStatus.NOT_FOUND, 'CASHIER_SHIFT_NOT_FOUND', 'Cashier shift not found');
      return rows[0];
    });
  }

  async adjust(ctx: RequestCtx, shiftId: string, direction: 'IN' | 'OUT', amount: string, reason: string) {
    const outletId = this.outletId(ctx);
    if (BigInt(amount) > MAX_BIGINT) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'CASH_AMOUNT_TOO_LARGE', 'Cash amount exceeds the supported integer range');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const shift = await c.query(
        `SELECT id FROM cashier_shifts
          WHERE id = $1 AND outlet_id = $2 AND user_id = $3 AND status = 'OPEN' AND deleted_at IS NULL
          FOR UPDATE`,
        [shiftId, outletId, ctx.userId],
      );
      if (!shift.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'OPEN_CASHIER_SHIFT_NOT_FOUND', 'Open cashier shift not found');
      const [adjustment] = await drizzle(c).insert(cashierShiftAdjustments).values({
        tenantId: ctx.tenantId!, outletId, shiftId, direction, amount: BigInt(amount),
        reason, recordedBy: ctx.userId,
      }).returning({
        id: cashierShiftAdjustments.id, direction: cashierShiftAdjustments.direction,
        amount: sql<string>`${cashierShiftAdjustments.amount}::text`, reason: cashierShiftAdjustments.reason,
        createdAt: cashierShiftAdjustments.createdAt,
      });
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'cashier_shift.adjust', entity: 'cashier_shift_adjustment', entityId: adjustment.id,
        meta: { shiftId, direction, amount, reason },
      });
      return adjustment;
    });
  }

  async report(ctx: RequestCtx, q: PaginationQuery) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const total = (await c.query(
        'SELECT count(*)::int AS total FROM cashier_shifts WHERE outlet_id = $1 AND deleted_at IS NULL',
        [outletId],
      )).rows[0].total as number;
      const { rows } = await c.query(
        `SELECT s.id, s.user_id AS "userId", s.status, s.opening_cash::text AS "openingCash",
                s.expected_cash::text AS "expectedCash", s.counted_cash::text AS "countedCash",
                s.variance::text AS variance, s.opened_at AS "openedAt", s.closed_at AS "closedAt",
                (COALESCE((SELECT sum(amount) FROM invoice_payments WHERE shift_id = s.id AND method = 'CASH'),0)
                 - COALESCE((SELECT sum(amount) FROM invoice_refunds WHERE shift_id = s.id AND method = 'CASH'),0))::text AS "netCashPayments",
                (COALESCE((SELECT sum(amount) FROM cashier_shift_adjustments WHERE shift_id = s.id AND direction = 'IN'),0)
                 - COALESCE((SELECT sum(amount) FROM cashier_shift_adjustments WHERE shift_id = s.id AND direction = 'OUT'),0))::text AS "netAdjustments"
           FROM cashier_shifts s
          WHERE s.outlet_id = $1 AND s.deleted_at IS NULL
          ORDER BY s.opened_at DESC, s.id DESC LIMIT $2 OFFSET $3`,
        [outletId, q.limit, q.offset],
      );
      return new Page(rows, total, q.page, q.limit);
    });
  }
}
