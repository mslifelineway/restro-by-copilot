import { HttpStatus, Injectable } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { drizzlePgErrorCode } from '../db/drizzle-errors';
import { printerStations } from '../db/schema/printers';

type StationInput = { code: string; name: string };
const CLAIM_LEASE_SECONDS = 60;

@Injectable()
export class PrinterDispatchService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage printer routing');
    return ctx.outletId;
  }

  async listStations(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) =>
      c.query(
        `SELECT ps.id, ps.code, ps.name, ps.is_active AS "isActive", ps.version,
                COALESCE(json_agg(json_build_object('id', cat.id, 'name', cat.name)
                  ORDER BY cat.name) FILTER (WHERE cat.id IS NOT NULL), '[]') AS categories
           FROM printer_stations ps
           LEFT JOIN printer_station_categories psc ON psc.printer_station_id = ps.id
           LEFT JOIN categories cat ON cat.id = psc.category_id AND cat.deleted_at IS NULL
          WHERE ps.outlet_id = $1 AND ps.deleted_at IS NULL
          GROUP BY ps.id ORDER BY ps.name`,
        [outletId],
      ).then((result) => result.rows));
  }

  async createStation(ctx: RequestCtx, input: StationInput) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      try {
        const [station] = await drizzle(c).insert(printerStations).values({
          tenantId: ctx.tenantId!, outletId, code: input.code, name: input.name,
        }).returning({
          id: printerStations.id, code: printerStations.code, name: printerStations.name,
          isActive: printerStations.isActive,
        });
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'printer.station.create', entity: 'printer_station', entityId: station.id,
        });
        return station;
      } catch (error) {
        if (drizzlePgErrorCode(error) === '23505') {
          throw new AppException(HttpStatus.CONFLICT, 'PRINTER_STATION_CODE_TAKEN', 'A printer station with this code already exists at this outlet');
        }
        throw error;
      }
    });
  }

  async setCategories(ctx: RequestCtx, stationId: string, categoryIds: string[]) {
    const outletId = this.outletId(ctx);
    if (new Set(categoryIds).size !== categoryIds.length) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'DUPLICATE_PRINTER_CATEGORY', 'Each menu category may only be routed once');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows: stations } = await c.query(
        'SELECT id FROM printer_stations WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL FOR UPDATE',
        [stationId, outletId],
      );
      if (!stations.length) throw new AppException(HttpStatus.NOT_FOUND, 'PRINTER_STATION_NOT_FOUND', 'Printer station not found');
      if (categoryIds.length) {
        const found = await c.query(
          'SELECT id FROM categories WHERE id = ANY($1::uuid[]) AND outlet_id = $2 AND deleted_at IS NULL',
          [categoryIds, outletId],
        );
        if (found.rowCount !== categoryIds.length) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'CATEGORY_NOT_FOUND', 'One or more categories are unavailable at this outlet');
        }
      }
      await c.query('DELETE FROM printer_station_categories WHERE printer_station_id = $1 AND outlet_id = $2', [stationId, outletId]);
      try {
        for (const categoryId of categoryIds) {
          await c.query(
            `INSERT INTO printer_station_categories (tenant_id, outlet_id, printer_station_id, category_id)
             VALUES ($1,$2,$3,$4)`,
            [ctx.tenantId, outletId, stationId, categoryId],
          );
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '23505') throw new AppException(HttpStatus.CONFLICT, 'CATEGORY_ALREADY_ROUTED', 'A menu category is already assigned to another printer station');
        throw error;
      }
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'printer.station.route_categories', entity: 'printer_station', entityId: stationId,
        meta: { categoryIds },
      });
    });
  }

  async queueKot(c: PoolClient, ctx: RequestCtx, ticketId: string, orderId: string) {
    const stations = await c.query(
      `SELECT ps.id AS "stationId", k.ticket_number::text AS "ticketNumber",
              o.order_type AS "orderType", o.table_id AS "tableId",
              COALESCE(t.name, '') AS "tableName", k.created_at AS "createdAt",
              json_agg(json_build_object(
                'itemName', oi.item_name, 'variantName', oi.variant_name,
                'quantity', oi.quantity, 'notes', oi.notes, 'addOns', oi.add_ons
              ) ORDER BY oi.created_at, oi.id) AS items
         FROM printer_stations ps
         JOIN printer_station_categories psc ON psc.printer_station_id = ps.id
         JOIN order_items oi ON oi.category_id = psc.category_id
                            AND oi.kot_ticket_id = $1 AND oi.deleted_at IS NULL
         JOIN kot_tickets k ON k.id = $1
         JOIN orders o ON o.id = $2
         LEFT JOIN dining_tables t ON t.id = o.table_id
        WHERE ps.outlet_id = $3 AND ps.is_active AND ps.deleted_at IS NULL
        GROUP BY ps.id, k.id, o.id, t.id ORDER BY ps.name`,
      [ticketId, orderId, ctx.outletId],
    );
    for (const station of stations.rows) {
      const payload = {
        ticketNumber: station.ticketNumber,
        orderId,
        orderType: station.orderType,
        tableName: station.tableId ? station.tableName : null,
        createdAt: station.createdAt.toISOString(),
        items: station.items,
      };
      await c.query(
        `INSERT INTO print_jobs (tenant_id, outlet_id, kot_ticket_id, printer_station_id, payload)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [ctx.tenantId, ctx.outletId, ticketId, station.stationId, JSON.stringify(payload)],
      );
    }
    const routedCount = (await c.query(
      `SELECT count(DISTINCT oi.id)::int AS count
         FROM order_items oi JOIN printer_station_categories psc ON psc.category_id = oi.category_id
         JOIN printer_stations ps ON ps.id = psc.printer_station_id AND ps.is_active AND ps.deleted_at IS NULL
        WHERE oi.kot_ticket_id = $1 AND ps.outlet_id = $2 AND oi.deleted_at IS NULL`,
      [ticketId, ctx.outletId],
    )).rows[0].count as number;
    const totalCount = (await c.query(
      'SELECT count(*)::int AS count FROM order_items WHERE kot_ticket_id = $1 AND deleted_at IS NULL',
      [ticketId],
    )).rows[0].count as number;
    return { queued: stations.rows.length, routedItems: routedCount, unroutedItems: totalCount - routedCount };
  }

  async claim(ctx: RequestCtx, stationId: string, limit: number) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const station = await c.query(
        'SELECT id FROM printer_stations WHERE id = $1 AND outlet_id = $2 AND is_active AND deleted_at IS NULL',
        [stationId, outletId],
      );
      if (!station.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'PRINTER_STATION_NOT_FOUND', 'Active printer station not found');
      const { rows } = await c.query(
        `WITH candidates AS (
           SELECT id FROM print_jobs
            WHERE printer_station_id = $1 AND outlet_id = $2 AND deleted_at IS NULL
              AND (status = 'QUEUED' OR (status = 'CLAIMED' AND lease_until < now()))
            ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $3
         )
         UPDATE print_jobs j
            SET status = 'CLAIMED', claimed_by = $4,
                lease_until = now() + ($5::int * interval '1 second'),
                attempts = attempts + 1, last_error = NULL
           FROM candidates c WHERE j.id = c.id
           RETURNING j.id, j.kot_ticket_id AS "kotTicketId", j.payload, j.attempts,
                     j.lease_until AS "leaseUntil"`,
        [stationId, outletId, limit, ctx.userId, CLAIM_LEASE_SECONDS],
      );
      return rows;
    });
  }

  async acknowledge(ctx: RequestCtx, jobId: string, status: 'PRINTED' | 'FAILED', errorMessage?: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const job = await c.query(
        `UPDATE print_jobs
            SET status = $3, printed_at = CASE WHEN $3 = 'PRINTED' THEN now() ELSE NULL END,
                last_error = CASE WHEN $3 = 'FAILED' THEN $4 ELSE NULL END,
                claimed_by = NULL, lease_until = NULL
          WHERE id = $1 AND outlet_id = $2 AND status = 'CLAIMED' AND claimed_by = $5
          RETURNING id, kot_ticket_id AS "kotTicketId"`,
        [jobId, outletId, status, errorMessage?.slice(0, 500) ?? null, ctx.userId],
      );
      if (!job.rowCount) throw new AppException(HttpStatus.CONFLICT, 'PRINT_JOB_NOT_CLAIMED', 'Print job is not currently claimed by this user');
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: `printer.job.${status.toLowerCase()}`, entity: 'print_job', entityId: job.rows[0].id,
        meta: { kotTicketId: job.rows[0].kotTicketId, error: status === 'FAILED' ? errorMessage?.slice(0, 200) : undefined },
      });
    });
  }

  async retry(ctx: RequestCtx, jobId: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const result = await c.query(
        `UPDATE print_jobs SET status = 'QUEUED', last_error = NULL
          WHERE id = $1 AND outlet_id = $2 AND status = 'FAILED' AND deleted_at IS NULL
          RETURNING id`,
        [jobId, outletId],
      );
      if (!result.rowCount) throw new AppException(HttpStatus.CONFLICT, 'PRINT_JOB_NOT_RETRYABLE', 'Only failed print jobs can be retried');
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'printer.job.retry', entity: 'print_job', entityId: jobId,
      });
    });
  }
}
