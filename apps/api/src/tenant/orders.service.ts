import { HttpStatus, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { Page, PaginationQuery } from '../common/pagination';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { orders, orderItems, kotTickets } from '../db/schema/orders';
import { menuRecipes, stockLedger } from '../db/schema/inventory';
import { diningTables } from '../db/schema/dining-tables';
import { PrinterDispatchService } from './printer-dispatch.service';

type OrderLineInput = { variantId: string; quantity: number; notes?: string; addOnIds?: string[] };
type OrderInput = { orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'; tableId?: string; notes?: string; items: OrderLineInput[] };
type KotStatus = 'PREPARING' | 'READY' | 'SERVED';
type KotQueueStatus = 'QUEUED' | 'PREPARING' | 'READY';

@Injectable()
export class OrdersService {
  constructor(private db: DbService, private audit: AuditService, private printers: PrinterDispatchService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage orders');
    return ctx.outletId;
  }

  async list(ctx: RequestCtx, q: PaginationQuery) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(orders)
        .where(and(eq(orders.outletId, outletId), isNull(orders.deletedAt)));
      const rows = await tx.select({
        id: orders.id, orderType: orders.orderType, status: orders.status, tableId: orders.tableId,
        billingGroupId: orders.billingGroupId, assignedWaiterId: orders.assignedWaiterId,
        notes: orders.notes, createdAt: orders.createdAt,
      }).from(orders)
        .where(and(eq(orders.outletId, outletId), isNull(orders.deletedAt)))
        .orderBy(desc(orders.createdAt)).limit(q.limit).offset(q.offset);
      return new Page(rows, count.total, q.page, q.limit);
    });
  }

  async get(ctx: RequestCtx, id: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [order] = await tx.select({
        id: orders.id, orderType: orders.orderType, status: orders.status, tableId: orders.tableId,
        billingGroupId: orders.billingGroupId, assignedWaiterId: orders.assignedWaiterId,
        notes: orders.notes, createdAt: orders.createdAt, updatedAt: orders.updatedAt,
      }).from(orders).where(and(eq(orders.id, id), eq(orders.outletId, outletId), isNull(orders.deletedAt))).limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      const items = await tx.select({
        id: orderItems.id, menuItemId: orderItems.menuItemId, variantId: orderItems.variantId,
        categoryId: orderItems.categoryId,
        itemName: orderItems.itemName, variantName: orderItems.variantName, quantity: orderItems.quantity,
        unitPrice: sql<string>`${orderItems.unitPrice}::text`, taxCode: orderItems.taxCode, cgstRate: orderItems.cgstRate,
        sgstRate: orderItems.sgstRate, igstRate: orderItems.igstRate, addOns: orderItems.addOns,
        notes: orderItems.notes, status: orderItems.status, kotTicketId: orderItems.kotTicketId,
      }).from(orderItems).where(and(eq(orderItems.orderId, id), isNull(orderItems.deletedAt))).orderBy(asc(orderItems.createdAt));
      const tickets = await tx.select({
        id: kotTickets.id, ticketNumber: sql<string>`${kotTickets.ticketNumber}::text`,
        status: kotTickets.status, createdAt: kotTickets.createdAt,
      }).from(kotTickets).where(and(eq(kotTickets.orderId, id), isNull(kotTickets.deletedAt))).orderBy(asc(kotTickets.createdAt));
      const joinedTables = await tx.select({
        id: diningTables.id, code: diningTables.code, name: diningTables.name, capacity: diningTables.capacity,
      }).from(diningTables).where(and(
        eq(diningTables.mergedOrderId, id), eq(diningTables.outletId, outletId), isNull(diningTables.deletedAt),
      )).orderBy(asc(diningTables.code));
      return { ...order, items, kotTickets: tickets, joinedTables };
    });
  }

  async listWaiters(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT DISTINCT u.id, u.name
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
          WHERE u.tenant_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
            AND (ur.outlet_id = $2 OR ur.outlet_id IS NULL)
          ORDER BY u.name, u.id`,
        [ctx.tenantId, outletId],
      );
      return rows;
    });
  }

  async assignWaiter(ctx: RequestCtx, orderId: string, waiterId: string | null) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
      const tx = drizzle(c);
      const [order] = await tx.select({ id: orders.id, status: orders.status })
        .from(orders).where(and(
          eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt),
        )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_ACTIVE', 'A waiter cannot be assigned to a completed or cancelled order');
      }
      if (waiterId) {
        const waiter = await c.query(
          `SELECT 1
             FROM users u
             JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
            WHERE u.id = $1 AND u.tenant_id = $2 AND u.status = 'active' AND u.deleted_at IS NULL
              AND (ur.outlet_id = $3 OR ur.outlet_id IS NULL)
            LIMIT 1`,
          [waiterId, ctx.tenantId, outletId],
        );
        if (!waiter.rowCount) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'WAITER_NOT_ASSIGNED_TO_OUTLET', 'Select an active user assigned to this outlet');
        }
      }
      await tx.update(orders).set({ assignedWaiterId: waiterId }).where(eq(orders.id, orderId));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.waiter.assign', entity: 'order', entityId: orderId,
        meta: { waiterId },
      });
    });
  }

  async kotQueue(ctx: RequestCtx, status: KotQueueStatus | undefined, q: PaginationQuery) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const statusClause = status ? 'AND k.status = $2' : "AND k.status IN ('QUEUED', 'PREPARING', 'READY')";
      const values = status ? [outletId, status, q.limit, q.offset] : [outletId, q.limit, q.offset];
      const limitParameter = status ? '$3' : '$2';
      const offsetParameter = status ? '$4' : '$3';
      const count = await c.query(
        `SELECT count(*)::int AS total FROM kot_tickets k
          WHERE k.outlet_id = $1 AND k.deleted_at IS NULL ${statusClause}`,
        status ? values.slice(0, 2) : [outletId],
      );
      const rows = await c.query(
        `SELECT k.id, k.ticket_number::text AS "ticketNumber", k.status, k.created_at AS "createdAt",
                o.id AS "orderId", o.order_type AS "orderType", o.table_id AS "tableId",
                t.name AS "tableName", t.code AS "tableCode",
                COALESCE(json_agg(json_build_object(
                  'id', oi.id, 'itemName', oi.item_name, 'variantName', oi.variant_name,
                  'quantity', oi.quantity, 'notes', oi.notes, 'addOns', oi.add_ons
                ) ORDER BY oi.created_at) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
           FROM kot_tickets k
           JOIN orders o ON o.id = k.order_id AND o.deleted_at IS NULL
           LEFT JOIN dining_tables t ON t.id = o.table_id
           LEFT JOIN order_items oi ON oi.kot_ticket_id = k.id AND oi.deleted_at IS NULL
          WHERE k.outlet_id = $1 AND k.deleted_at IS NULL ${statusClause}
          GROUP BY k.id, o.id, t.id
          ORDER BY k.created_at
          LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
        values,
      );
      return new Page(rows.rows, count.rows[0].total, q.page, q.limit);
    });
  }

  async create(ctx: RequestCtx, input: OrderInput) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      let table: { state: string } | undefined;
      if (input.orderType === 'DINE_IN') {
        if (!input.tableId) throw new AppException(HttpStatus.BAD_REQUEST, 'TABLE_REQUIRED', 'Dine-in orders require a table');
        const [row] = await tx.select({
          id: diningTables.id, state: diningTables.state, mergedOrderId: diningTables.mergedOrderId,
        })
          .from(diningTables).where(and(
            eq(diningTables.id, input.tableId), eq(diningTables.outletId, outletId), isNull(diningTables.deletedAt),
          )).for('update').limit(1);
        if (!row) throw new AppException(HttpStatus.NOT_FOUND, 'TABLE_NOT_FOUND', 'Floor table not found');
        if (row.mergedOrderId !== null || !['AVAILABLE', 'RESERVED'].includes(row.state)) {
          throw new AppException(HttpStatus.CONFLICT, 'TABLE_NOT_AVAILABLE', 'Table is not available for a new order');
        }
        table = row;
      } else if (input.tableId) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'TABLE_NOT_ALLOWED', 'Only dine-in orders may be assigned a table');
      }

      const [created] = await tx.insert(orders).values({
        tenantId: ctx.tenantId!, outletId, tableId: input.tableId ?? null,
        orderType: input.orderType, notes: input.notes ?? '', createdBy: ctx.userId,
      }).returning({ id: orders.id, status: orders.status, orderType: orders.orderType, tableId: orders.tableId });

      for (const line of input.items) {
        const { rows: variants } = await c.query(
          `SELECT m.id AS "menuItemId", m.name AS "itemName", m.category_id AS "categoryId", m.tax_slab_id AS "taxSlabId",
                  v.id AS "variantId", v.name AS "variantName", t.code AS "taxCode",
                  t.cgst_rate AS "cgstRate", t.sgst_rate AS "sgstRate", t.igst_rate AS "igstRate",
                  COALESCE(cv.price, ov.price, v.base_price)::text AS price
             FROM variants v
             JOIN menu_items m ON m.id = v.menu_item_id AND m.deleted_at IS NULL AND m.is_available
             JOIN categories cat ON cat.id = m.category_id AND cat.deleted_at IS NULL AND cat.is_active
             JOIN tax_slabs t ON t.id = m.tax_slab_id AND t.deleted_at IS NULL AND t.effective_from <= now()
             LEFT JOIN outlet_variant_prices ov ON ov.variant_id = v.id AND ov.outlet_id = $2
             LEFT JOIN channel_variant_prices cv ON cv.variant_id = v.id AND cv.outlet_id = $2 AND cv.channel = $3
            WHERE v.id = $1 AND v.deleted_at IS NULL AND cat.outlet_id = $2`,
          [line.variantId, outletId, input.orderType],
        );
        const variant = variants[0];
        if (!variant) throw new AppException(HttpStatus.BAD_REQUEST, 'MENU_VARIANT_UNAVAILABLE', 'One or more selected menu variants are unavailable');

        const addOnIds = line.addOnIds ?? [];
        if (new Set(addOnIds).size !== addOnIds.length) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'DUPLICATE_ADD_ON', 'An add-on may only be selected once per order item');
        }
        let addOns: Array<{ id: string; name: string; price: string }> = [];
        const assignedGroups = await c.query(
          `SELECT g.id, g.min_selection AS "minSelection", g.max_selection AS "maxSelection"
             FROM item_add_on_groups iag
             JOIN add_on_groups g ON g.id = iag.add_on_group_id AND g.deleted_at IS NULL
            WHERE iag.menu_item_id = $1`,
          [variant.menuItemId],
        );
        if (addOnIds.length) {
          const found = await c.query(
            `SELECT a.id, a.name, a.price::text AS price, a.add_on_group_id AS "groupId"
               FROM add_ons a
               JOIN item_add_on_groups iag ON iag.add_on_group_id = a.add_on_group_id AND iag.menu_item_id = $2
               JOIN add_on_groups g ON g.id = a.add_on_group_id AND g.deleted_at IS NULL
              WHERE a.id = ANY($1::uuid[]) AND a.is_active AND a.deleted_at IS NULL`,
            [addOnIds, variant.menuItemId],
          );
          if (found.rowCount !== addOnIds.length) {
            throw new AppException(HttpStatus.BAD_REQUEST, 'ADD_ON_NOT_AVAILABLE', 'One or more add-ons are not available for this menu item');
          }
          addOns = found.rows;
          const counts = new Map<string, number>();
          for (const addOn of found.rows) counts.set(addOn.groupId, (counts.get(addOn.groupId) ?? 0) + 1);
          for (const group of assignedGroups.rows) {
            const count = counts.get(group.id) ?? 0;
            if (count < group.minSelection || count > group.maxSelection) {
              throw new AppException(HttpStatus.BAD_REQUEST, 'ADD_ON_SELECTION_INVALID', 'Selected add-ons do not satisfy the item group selection rules');
            }
          }
        } else if (assignedGroups.rows.some((group) => group.minSelection > 0)) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'ADD_ON_SELECTION_REQUIRED', 'One or more required add-on groups have no selected option');
        }

        await tx.insert(orderItems).values({
          tenantId: ctx.tenantId!, outletId, orderId: created.id,
          menuItemId: variant.menuItemId, variantId: variant.variantId, categoryId: variant.categoryId,
          itemName: variant.itemName, variantName: variant.variantName,
          quantity: line.quantity, unitPrice: BigInt(variant.price),
          taxCode: variant.taxCode, cgstRate: variant.cgstRate, sgstRate: variant.sgstRate, igstRate: variant.igstRate,
          addOns, notes: line.notes ?? '',
        });
      }

      if (table) await tx.update(diningTables).set({ state: 'IN_USE' }).where(eq(diningTables.id, input.tableId!));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.create', entity: 'order', entityId: created.id,
        meta: { orderType: input.orderType, tableId: input.tableId ?? null, itemCount: input.items.length },
      });
      return created;
    });
  }

  async createKot(ctx: RequestCtx, orderId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [order] = await tx.select({ id: orders.id, status: orders.status })
        .from(orders).where(and(eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt)))
        .for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (['COMPLETED', 'CANCELLED', 'HELD'].includes(order.status)) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_ACTIVE', 'Cannot send a held or inactive order to the kitchen');
      }
      const pending = await tx.select({
        id: orderItems.id, menuItemId: orderItems.menuItemId, quantity: orderItems.quantity,
      }).from(orderItems).where(and(
        eq(orderItems.orderId, orderId), isNull(orderItems.kotTicketId), isNull(orderItems.deletedAt), eq(orderItems.status, 'PENDING'),
      ));
      if (!pending.length) throw new AppException(HttpStatus.CONFLICT, 'NO_PENDING_KOT_ITEMS', 'There are no new items to send to the kitchen');
      const [ticket] = await tx.insert(kotTickets).values({
        tenantId: ctx.tenantId!, outletId, orderId, createdBy: ctx.userId,
      }).returning({
        id: kotTickets.id, ticketNumber: sql<string>`${kotTickets.ticketNumber}::text`,
        status: kotTickets.status, createdAt: kotTickets.createdAt,
      });
      const recipes = await tx.select({
        orderItemId: orderItems.id, inventoryItemId: menuRecipes.inventoryItemId,
        itemQuantity: orderItems.quantity, recipeQuantityMilli: menuRecipes.quantityMilli,
      }).from(orderItems).innerJoin(menuRecipes, and(
        eq(menuRecipes.menuItemId, orderItems.menuItemId),
        eq(menuRecipes.outletId, outletId),
        isNull(menuRecipes.deletedAt),
      )).where(inArray(orderItems.id, pending.map((item) => item.id)));
      const consumption = recipes.map((recipe) => ({
        tenantId: ctx.tenantId!,
        outletId,
        inventoryItemId: recipe.inventoryItemId,
        quantityDeltaMilli: -(recipe.recipeQuantityMilli * BigInt(recipe.itemQuantity)),
        reason: 'CONSUMPTION',
        reference: `KOT ${ticket.ticketNumber}`,
        sourceKey: `kot:${ticket.id}:order-item:${recipe.orderItemId}:inventory-item:${recipe.inventoryItemId}`,
        recordedBy: ctx.userId,
      }));
      if (consumption.length) {
        await tx.insert(stockLedger).values(consumption)
          .onConflictDoNothing({ target: [stockLedger.tenantId, stockLedger.sourceKey] });
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'inventory.stock.kot_consumption', entity: 'kot_ticket', entityId: ticket.id,
          meta: { orderId, movementCount: consumption.length },
        });
      }
      await tx.update(orderItems).set({ kotTicketId: ticket.id, status: 'IN_KITCHEN' }).where(and(
        eq(orderItems.orderId, orderId), isNull(orderItems.kotTicketId), isNull(orderItems.deletedAt), eq(orderItems.status, 'PENDING'),
      ));
      await tx.update(orders).set({ status: 'IN_PROGRESS' }).where(eq(orders.id, orderId));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.kot.create', entity: 'kot_ticket', entityId: ticket.id,
        meta: { orderId, itemCount: pending.length },
      });
      const printing = await this.printers.queueKot(c, ctx, ticket.id, orderId);
      return { ...ticket, itemCount: pending.length, printing };
    });
  }

  async hold(ctx: RequestCtx, orderId: string) {
    await this.changeHoldState(ctx, orderId, 'OPEN', 'HELD');
  }

  async resume(ctx: RequestCtx, orderId: string) {
    await this.changeHoldState(ctx, orderId, 'HELD', 'OPEN');
  }

  private async changeHoldState(ctx: RequestCtx, orderId: string, from: 'OPEN' | 'HELD', to: 'OPEN' | 'HELD') {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [order] = await tx.select({ id: orders.id, status: orders.status })
        .from(orders).where(and(eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt)))
        .for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.status !== from) {
        throw new AppException(HttpStatus.CONFLICT, 'INVALID_ORDER_HOLD_TRANSITION', `Cannot change order status from ${order.status} to ${to}`);
      }
      if (from === 'OPEN') {
        const [tickets] = await tx.select({ count: sql<number>`count(*)::int` }).from(kotTickets)
          .where(and(eq(kotTickets.orderId, orderId), isNull(kotTickets.deletedAt)));
        if (tickets.count > 0) {
          throw new AppException(HttpStatus.CONFLICT, 'ORDER_ALREADY_SENT_TO_KITCHEN', 'An order sent to the kitchen cannot be held');
        }
      }
      await tx.update(orders).set({ status: to }).where(eq(orders.id, orderId));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: to === 'HELD' ? 'order.hold' : 'order.resume', entity: 'order', entityId: orderId,
        meta: { from, to },
      });
    });
  }

  async transferTable(ctx: RequestCtx, orderId: string, destinationTableId: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
      const tx = drizzle(c);
      const [order] = await tx.select({
        id: orders.id, orderType: orders.orderType, status: orders.status, tableId: orders.tableId,
      }).from(orders).where(and(
        eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt),
      )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.orderType !== 'DINE_IN' || !order.tableId) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'DINE_IN_ORDER_REQUIRED', 'Only dine-in orders can be transferred between tables');
      }
      if (!['OPEN', 'HELD', 'IN_PROGRESS', 'READY'].includes(order.status)) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_ACTIVE', 'Completed or cancelled orders cannot be transferred');
      }
      if (order.tableId === destinationTableId) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'TABLE_ALREADY_ASSIGNED', 'Choose a different destination table');
      }
      const mergedTables = await tx.select({ id: diningTables.id }).from(diningTables).where(and(
        eq(diningTables.mergedOrderId, orderId), eq(diningTables.outletId, outletId), isNull(diningTables.deletedAt),
      ));
      if (mergedTables.length) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_HAS_JOINED_TABLES', 'Unjoin additional tables before transferring this order');
      }
      const lockedTables = await tx.select({ id: diningTables.id, state: diningTables.state })
        .from(diningTables)
        .where(and(inArray(diningTables.id, [order.tableId, destinationTableId]), eq(diningTables.outletId, outletId), isNull(diningTables.deletedAt)))
        .orderBy(asc(diningTables.id))
        .for('update');
      const destination = lockedTables.find((table) => table.id === destinationTableId);
      if (!destination) throw new AppException(HttpStatus.NOT_FOUND, 'TABLE_NOT_FOUND', 'Destination table not found');
      if (!lockedTables.some((table) => table.id === order.tableId)) {
        throw new AppException(HttpStatus.NOT_FOUND, 'TABLE_NOT_FOUND', 'Current table not found');
      }
      if (!['AVAILABLE', 'RESERVED'].includes(destination.state)) {
        throw new AppException(HttpStatus.CONFLICT, 'TABLE_NOT_AVAILABLE', 'Destination table is not available');
      }
      const destinationOrder = await c.query(
        `SELECT 1 FROM orders
          WHERE table_id = $1 AND outlet_id = $2 AND id <> $3
            AND status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY') AND deleted_at IS NULL
          LIMIT 1`,
        [destinationTableId, outletId, orderId],
      );
      if (destinationOrder.rowCount) {
        throw new AppException(HttpStatus.CONFLICT, 'TABLE_HAS_ACTIVE_ORDER', 'Destination table already has an active order');
      }

      await tx.update(orders).set({ tableId: destinationTableId }).where(and(
        eq(orders.id, orderId), eq(orders.outletId, outletId),
      ));
      await tx.update(diningTables).set({ state: 'IN_USE' }).where(and(
        eq(diningTables.id, destinationTableId), eq(diningTables.outletId, outletId),
      ));
      const sourceOrder = await c.query(
        `SELECT 1 FROM orders
          WHERE table_id = $1 AND outlet_id = $2 AND id <> $3
            AND status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY') AND deleted_at IS NULL
          LIMIT 1`,
        [order.tableId, outletId, orderId],
      );
      if (!sourceOrder.rowCount) {
        await tx.update(diningTables).set({ state: 'AVAILABLE' }).where(and(
          eq(diningTables.id, order.tableId), eq(diningTables.outletId, outletId),
        ));
      }
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.table.transfer', entity: 'order', entityId: orderId,
        meta: { fromTableId: order.tableId, toTableId: destinationTableId },
      });
    });
  }

  async mergeTables(ctx: RequestCtx, orderId: string, tableIds: string[]) {
    const outletId = this.outletId(ctx);
    if (!tableIds.length || new Set(tableIds).size !== tableIds.length) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_TABLE_MERGE', 'Select one or more distinct additional tables');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
      const tx = drizzle(c);
      const [order] = await tx.select({
        id: orders.id, orderType: orders.orderType, status: orders.status, tableId: orders.tableId,
      }).from(orders).where(and(
        eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt),
      )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.orderType !== 'DINE_IN' || !order.tableId) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'DINE_IN_ORDER_REQUIRED', 'Only dine-in orders can join additional tables');
      }
      if (!['OPEN', 'HELD', 'IN_PROGRESS', 'READY'].includes(order.status)) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_ACTIVE', 'Completed or cancelled orders cannot join tables');
      }
      if (tableIds.includes(order.tableId)) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'TABLE_ALREADY_ASSIGNED', 'The order table cannot also be an additional table');
      }
      const lockedTables = await tx.select({
        id: diningTables.id, state: diningTables.state, mergedOrderId: diningTables.mergedOrderId,
      }).from(diningTables).where(and(
        inArray(diningTables.id, tableIds), eq(diningTables.outletId, outletId), isNull(diningTables.deletedAt),
      )).orderBy(asc(diningTables.id)).for('update');
      if (lockedTables.length !== tableIds.length) {
        throw new AppException(HttpStatus.NOT_FOUND, 'TABLE_NOT_FOUND', 'One or more additional tables were not found at this outlet');
      }
      if (lockedTables.some((table) => table.mergedOrderId !== null || !['AVAILABLE', 'RESERVED'].includes(table.state))) {
        throw new AppException(HttpStatus.CONFLICT, 'TABLE_NOT_AVAILABLE', 'Every additional table must be available or reserved');
      }
      const activeOrders = await c.query(
        `SELECT 1 FROM orders
          WHERE table_id = ANY($1::uuid[]) AND outlet_id = $2 AND id <> $3
            AND status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY') AND deleted_at IS NULL
          LIMIT 1`,
        [tableIds, outletId, orderId],
      );
      if (activeOrders.rowCount) {
        throw new AppException(HttpStatus.CONFLICT, 'TABLE_HAS_ACTIVE_ORDER', 'An additional table already has an active order');
      }
      await tx.update(diningTables).set({ state: 'IN_USE', mergedOrderId: orderId }).where(and(
        inArray(diningTables.id, tableIds), eq(diningTables.outletId, outletId),
      ));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.tables.merge', entity: 'order', entityId: orderId,
        meta: { tableIds },
      });
      return { orderId, primaryTableId: order.tableId, joinedTableIds: tableIds };
    });
  }

  async unmergeTables(ctx: RequestCtx, orderId: string, tableIds: string[]) {
    const outletId = this.outletId(ctx);
    if (!tableIds.length || new Set(tableIds).size !== tableIds.length) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_TABLE_UNMERGE', 'Select one or more distinct joined tables');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
      const tx = drizzle(c);
      const [order] = await tx.select({ id: orders.id, status: orders.status })
        .from(orders).where(and(
          eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt),
        )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (!['OPEN', 'HELD', 'IN_PROGRESS', 'READY'].includes(order.status)) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_ACTIVE', 'Completed or cancelled orders cannot unjoin tables');
      }
      const joined = await tx.select({ id: diningTables.id }).from(diningTables).where(and(
        inArray(diningTables.id, tableIds), eq(diningTables.outletId, outletId),
        eq(diningTables.mergedOrderId, orderId), isNull(diningTables.deletedAt),
      )).orderBy(asc(diningTables.id)).for('update');
      if (joined.length !== tableIds.length) {
        throw new AppException(HttpStatus.CONFLICT, 'TABLE_NOT_JOINED_TO_ORDER', 'One or more selected tables are not joined to this order');
      }
      await tx.update(diningTables).set({ state: 'AVAILABLE', mergedOrderId: null }).where(and(
        inArray(diningTables.id, tableIds), eq(diningTables.outletId, outletId),
        eq(diningTables.mergedOrderId, orderId),
      ));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.tables.unmerge', entity: 'order', entityId: orderId,
        meta: { tableIds },
      });
      return { orderId, releasedTableIds: tableIds };
    });
  }

  async updateKotStatus(ctx: RequestCtx, ticketId: string, next: KotStatus) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [ticketRef] = await tx.select({
        id: kotTickets.id, orderId: kotTickets.orderId, status: kotTickets.status,
      }).from(kotTickets).where(and(
        eq(kotTickets.id, ticketId), eq(kotTickets.outletId, outletId), isNull(kotTickets.deletedAt),
      )).limit(1);
      if (!ticketRef) throw new AppException(HttpStatus.NOT_FOUND, 'KOT_NOT_FOUND', 'KOT ticket not found');
      const [activeOrder] = await tx.select({ id: orders.id }).from(orders).where(and(
        eq(orders.id, ticketRef.orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt),
      )).for('update').limit(1);
      if (!activeOrder) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      const [ticket] = await tx.select({
        id: kotTickets.id, orderId: kotTickets.orderId, status: kotTickets.status,
      }).from(kotTickets).where(and(
        eq(kotTickets.id, ticketId), eq(kotTickets.outletId, outletId), isNull(kotTickets.deletedAt),
      )).for('update').limit(1);
      if (!ticket) throw new AppException(HttpStatus.NOT_FOUND, 'KOT_NOT_FOUND', 'KOT ticket not found');
      const allowed: Record<string, KotStatus[]> = {
        QUEUED: ['PREPARING'], PREPARING: ['READY'], READY: ['SERVED'], SERVED: [], CANCELLED: [],
      };
      if (ticket.status !== next && !allowed[ticket.status]?.includes(next)) {
        throw new AppException(HttpStatus.CONFLICT, 'INVALID_KOT_TRANSITION', `Cannot change KOT status from ${ticket.status} to ${next}`);
      }
      if (ticket.status === next) return;
      await tx.update(kotTickets).set({ status: next }).where(eq(kotTickets.id, ticketId));
      const itemStatus = next === 'SERVED' ? 'SERVED' : next === 'READY' ? 'READY' : 'IN_KITCHEN';
      await tx.update(orderItems).set({ status: itemStatus }).where(and(eq(orderItems.kotTicketId, ticketId), isNull(orderItems.deletedAt)));
      if (next === 'READY') {
        const [remaining] = await tx.select({ count: sql<number>`count(*)::int` }).from(orderItems).where(and(
          eq(orderItems.orderId, ticket.orderId), isNull(orderItems.deletedAt),
          sql`${orderItems.status} NOT IN ('READY', 'SERVED', 'CANCELLED')`,
        ));
        if (remaining.count === 0) await tx.update(orders).set({ status: 'READY' }).where(eq(orders.id, ticket.orderId));
      }
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.kot.status_change', entity: 'kot_ticket', entityId: ticketId,
        meta: { from: ticket.status, to: next, orderId: ticket.orderId },
      });
    });
  }

  async cancel(ctx: RequestCtx, orderId: string) {
    const outletId = this.outletId(ctx);
    await this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [order] = await tx.select({
        id: orders.id, status: orders.status, tableId: orders.tableId,
      }).from(orders).where(and(
        eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt),
      )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_ACTIVE', 'Order is already completed or cancelled');
      }
      const [served] = await tx.select({ count: sql<number>`count(*)::int` }).from(orderItems).where(and(
        eq(orderItems.orderId, orderId), eq(orderItems.status, 'SERVED'), isNull(orderItems.deletedAt),
      ));
      if (served.count > 0) throw new AppException(HttpStatus.CONFLICT, 'ORDER_HAS_SERVED_ITEMS', 'An order with served items cannot be cancelled');
      await tx.update(kotTickets).set({ status: 'CANCELLED' }).where(and(
        eq(kotTickets.orderId, orderId), sql`${kotTickets.status} NOT IN ('SERVED', 'CANCELLED')`,
        isNull(kotTickets.deletedAt),
      ));
      await tx.update(orderItems).set({ status: 'CANCELLED' }).where(and(
        eq(orderItems.orderId, orderId), isNull(orderItems.deletedAt),
      ));
      await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, orderId));
      if (order.tableId) {
        await tx.update(diningTables).set({ state: 'AVAILABLE' }).where(and(
          eq(diningTables.id, order.tableId), eq(diningTables.outletId, outletId),
        ));
      }
      await tx.update(diningTables).set({ state: 'AVAILABLE', mergedOrderId: null }).where(and(
        eq(diningTables.mergedOrderId, orderId), eq(diningTables.outletId, outletId),
      ));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'order.cancel', entity: 'order', entityId: orderId,
      });
    });
  }
}
