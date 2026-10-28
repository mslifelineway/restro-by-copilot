import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { inventoryItems, stockLedger } from '../db/schema/inventory';
import { purchaseOrderLines, purchaseOrders, purchaseReceiptLines, purchaseReceipts, suppliers } from '../db/schema/purchasing';

const MAX_BIGINT = 9223372036854775807n;

function toMilli(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

function fromMilli(value: string | bigint) {
  const milli = BigInt(value);
  const whole = milli / 1000n;
  const fraction = String(milli % 1000n).padStart(3, '0');
  return `${whole}.${fraction}`;
}

@Injectable()
export class PurchasingService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage purchasing');
    return ctx.outletId;
  }

  async listSuppliers(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT id, name, phone, email, created_at AS "createdAt"
           FROM suppliers WHERE outlet_id = $1 AND deleted_at IS NULL ORDER BY name`,
        [outletId],
      );
      return rows;
    });
  }

  async createSupplier(ctx: RequestCtx, input: { name: string; phone?: string; email?: string }) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      try {
        const [supplier] = await drizzle(c).insert(suppliers).values({
          tenantId: ctx.tenantId!, outletId, name: input.name, phone: input.phone ?? null, email: input.email ?? null,
        }).returning({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone, email: suppliers.email });
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'purchasing.supplier.create', entity: 'supplier', entityId: supplier.id,
        });
        return supplier;
      } catch (error) {
        if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
          throw new AppException(HttpStatus.CONFLICT, 'SUPPLIER_NAME_TAKEN', 'A supplier with this name already exists at this outlet');
        }
        throw error;
      }
    });
  }

  async listOrders(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT p.id, p.status, p.notes, p.created_at AS "createdAt",
                s.id AS "supplierId", s.name AS "supplierName",
                COALESCE(json_agg(json_build_object(
                  'id', l.id, 'inventoryItemId', l.inventory_item_id, 'itemName', i.name,
                  'orderedQuantity', l.ordered_quantity_milli::text,
                  'receivedQuantity', l.received_quantity_milli::text,
                  'unitCostPaise', l.unit_cost_paise::text
                ) ORDER BY i.name) FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS lines
           FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
           LEFT JOIN purchase_order_lines l ON l.purchase_order_id = p.id
           LEFT JOIN inventory_items i ON i.id = l.inventory_item_id
          WHERE p.outlet_id = $1 AND p.deleted_at IS NULL
          GROUP BY p.id, s.id ORDER BY p.created_at DESC, p.id DESC`,
        [outletId],
      );
      return rows.map((row) => ({
        ...row,
        lines: (row.lines as Array<{ orderedQuantity: string; receivedQuantity: string }>).map((line) => ({
          ...line, orderedQuantity: fromMilli(line.orderedQuantity), receivedQuantity: fromMilli(line.receivedQuantity),
        })),
      }));
    });
  }

  async createOrder(
    ctx: RequestCtx,
    input: { supplierId: string; notes?: string; lines: Array<{ inventoryItemId: string; quantity: string; unitCostPaise: string }> },
  ) {
    const outletId = this.outletId(ctx);
    if (!input.lines.length) throw new AppException(HttpStatus.BAD_REQUEST, 'PURCHASE_ORDER_EMPTY', 'A purchase order must contain at least one inventory item');
    const quantities = input.lines.map((line) => toMilli(line.quantity));
    const costs = input.lines.map((line) => BigInt(line.unitCostPaise));
    if (quantities.some((quantity) => quantity <= 0n || quantity > MAX_BIGINT) || costs.some((cost) => cost > MAX_BIGINT)) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'PURCHASE_ORDER_AMOUNT_TOO_LARGE', 'Purchase order quantity or unit cost exceeds the supported range');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const supplier = await tx.select({ id: suppliers.id }).from(suppliers).where(and(
        eq(suppliers.id, input.supplierId), eq(suppliers.outletId, outletId), isNull(suppliers.deletedAt),
      )).limit(1);
      if (!supplier.length) throw new AppException(HttpStatus.NOT_FOUND, 'SUPPLIER_NOT_FOUND', 'Supplier not found');
      const itemIds = input.lines.map((line) => line.inventoryItemId);
      const foundItems = await tx.select({ id: inventoryItems.id }).from(inventoryItems).where(and(
        inArray(inventoryItems.id, itemIds), eq(inventoryItems.outletId, outletId), isNull(inventoryItems.deletedAt),
      ));
      if (foundItems.length !== itemIds.length) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'PURCHASE_ITEM_NOT_FOUND', 'One or more inventory items are unavailable at this outlet');
      }
      const [order] = await tx.insert(purchaseOrders).values({
        tenantId: ctx.tenantId!, outletId, supplierId: input.supplierId,
        notes: input.notes ?? '', createdBy: ctx.userId,
      }).returning({ id: purchaseOrders.id, status: purchaseOrders.status, createdAt: purchaseOrders.createdAt });
      const savedLines = await tx.insert(purchaseOrderLines).values(input.lines.map((line, index) => ({
        tenantId: ctx.tenantId!, outletId, purchaseOrderId: order.id,
        inventoryItemId: line.inventoryItemId, orderedQuantityMilli: quantities[index],
        unitCostPaise: costs[index],
      }))).returning({ id: purchaseOrderLines.id, inventoryItemId: purchaseOrderLines.inventoryItemId });
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'purchasing.order.create', entity: 'purchase_order', entityId: order.id,
        meta: { supplierId: input.supplierId, lineCount: input.lines.length },
      });
      return { ...order, supplierId: input.supplierId, lines: input.lines.map((line, index) => ({
        id: savedLines.find((savedLine) => savedLine.inventoryItemId === line.inventoryItemId)!.id,
        inventoryItemId: line.inventoryItemId, orderedQuantity: fromMilli(quantities[index]),
        receivedQuantity: '0.000', unitCostPaise: costs[index].toString(),
      })) };
    });
  }

  async receive(
    ctx: RequestCtx,
    orderId: string,
    reference: string | undefined,
    lines: Array<{ purchaseOrderLineId: string; quantity: string }>,
  ) {
    const outletId = this.outletId(ctx);
    if (!lines.length) throw new AppException(HttpStatus.BAD_REQUEST, 'PURCHASE_RECEIPT_EMPTY', 'A receipt must contain at least one purchase order line');
    const quantities = lines.map((line) => toMilli(line.quantity));
    if (quantities.some((quantity) => quantity <= 0n || quantity > MAX_BIGINT)) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_RECEIPT_QUANTITY', 'Receipt quantities must be positive and within the supported range');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [order] = await tx.select({ id: purchaseOrders.id, status: purchaseOrders.status }).from(purchaseOrders).where(and(
        eq(purchaseOrders.id, orderId), eq(purchaseOrders.outletId, outletId), isNull(purchaseOrders.deletedAt),
      )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found');
      if (order.status === 'CANCELLED' || order.status === 'RECEIVED') {
        throw new AppException(HttpStatus.CONFLICT, 'PURCHASE_ORDER_NOT_RECEIVABLE', 'Purchase order is cancelled or fully received');
      }
      const receiptLines = [];
      for (let index = 0; index < lines.length; index += 1) {
        const [line] = await tx.select({
          id: purchaseOrderLines.id, inventoryItemId: purchaseOrderLines.inventoryItemId,
          ordered: purchaseOrderLines.orderedQuantityMilli, received: purchaseOrderLines.receivedQuantityMilli,
          unitCostPaise: purchaseOrderLines.unitCostPaise,
        }).from(purchaseOrderLines).where(and(
          eq(purchaseOrderLines.id, lines[index].purchaseOrderLineId),
          eq(purchaseOrderLines.purchaseOrderId, orderId),
        )).for('update').limit(1);
        if (!line) throw new AppException(HttpStatus.BAD_REQUEST, 'PURCHASE_ORDER_LINE_NOT_FOUND', 'A purchase order line is not part of this order');
        if (quantities[index] > line.ordered - line.received) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'RECEIPT_EXCEEDS_ORDERED', 'Received quantity exceeds the remaining ordered quantity');
        }
        receiptLines.push({ ...line, quantity: quantities[index] });
      }
      const [receipt] = await tx.insert(purchaseReceipts).values({
        tenantId: ctx.tenantId!, outletId, purchaseOrderId: orderId,
        receivedBy: ctx.userId, reference: reference ?? null,
      }).returning({ id: purchaseReceipts.id, receivedAt: purchaseReceipts.receivedAt });
      for (const line of receiptLines) {
        await tx.insert(purchaseReceiptLines).values({
          tenantId: ctx.tenantId!, outletId, receiptId: receipt.id, purchaseOrderLineId: line.id,
          inventoryItemId: line.inventoryItemId, quantityMilli: line.quantity,
          unitCostPaise: line.unitCostPaise,
        });
        await tx.insert(stockLedger).values({
          tenantId: ctx.tenantId!, outletId, inventoryItemId: line.inventoryItemId,
          quantityDeltaMilli: line.quantity, reason: 'RECEIPT', reference: `Receipt ${receipt.id}`,
          sourceKey: `purchase-receipt:${receipt.id}:line:${line.id}`, recordedBy: ctx.userId,
        });
        await tx.update(purchaseOrderLines).set({
          receivedQuantityMilli: line.received + line.quantity,
        }).where(eq(purchaseOrderLines.id, line.id));
      }
      const remaining = await tx.select({ count: sql<number>`count(*)::int` }).from(purchaseOrderLines).where(and(
        eq(purchaseOrderLines.purchaseOrderId, orderId),
        sql`${purchaseOrderLines.receivedQuantityMilli} < ${purchaseOrderLines.orderedQuantityMilli}`,
      ));
      const status = remaining[0].count === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
      await tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, orderId));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'purchasing.order.receive', entity: 'purchase_receipt', entityId: receipt.id,
        meta: { orderId, lineCount: receiptLines.length, reference: reference ?? null },
      });
      return {
        ...receipt, purchaseOrderId: orderId, status,
        lines: receiptLines.map((line) => ({
          purchaseOrderLineId: line.id, inventoryItemId: line.inventoryItemId, quantity: fromMilli(line.quantity),
          unitCostPaise: line.unitCostPaise.toString(),
        })),
      };
    });
  }

  async cancel(ctx: RequestCtx, orderId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const tx = drizzle(c);
      const [order] = await tx.select({ id: purchaseOrders.id, status: purchaseOrders.status }).from(purchaseOrders).where(and(
        eq(purchaseOrders.id, orderId), eq(purchaseOrders.outletId, outletId), isNull(purchaseOrders.deletedAt),
      )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found');
      if (order.status === 'RECEIVED' || order.status === 'CANCELLED') {
        throw new AppException(HttpStatus.CONFLICT, 'PURCHASE_ORDER_NOT_CANCELLABLE', 'Purchase order is already complete or cancelled');
      }
      await tx.update(purchaseOrders).set({ status: 'CANCELLED' }).where(eq(purchaseOrders.id, orderId));
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'purchasing.order.cancel', entity: 'purchase_order', entityId: orderId,
        meta: { previousStatus: order.status },
      });
      return { id: orderId, status: 'CANCELLED' };
    });
  }
}
