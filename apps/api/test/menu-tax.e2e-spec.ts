import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { config } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { runSeed } from '../src/db/seed';

const PASSWORD = 'correct-horse-battery';

describe('P1 menu, tax, and floor foundation', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tenants: Record<'a' | 'b', { slug: string; outletId: string; token: string }> = {} as never;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await runMigrations();
    await runSeed();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());

    const platformLogin = await http.post('/api/v1/auth/platform/login').send({
      email: config.platformAdminEmail,
      password: config.platformAdminPassword,
    });
    expect(platformLogin.status).toBe(200);
    const platformToken = platformLogin.body.data.accessToken as string;

    for (const key of ['a', 'b'] as const) {
      const slug = `menu-tax-${key}-${randomUUID().slice(0, 8)}`;
      const created = await http.post('/api/v1/platform/tenants').set(bearer(platformToken)).send({
        name: `Menu Tax ${key}`,
        slug,
        planCode: key === 'a' ? 'growth' : 'starter',
        ownerName: 'Owner',
        ownerEmail: `owner@${slug}.test`,
        ownerPassword: PASSWORD,
      });
      expect(created.status).toBe(201);
      const login = await http.post('/api/v1/auth/login').send({
        tenantSlug: slug,
        email: `owner@${slug}.test`,
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      tenants[key] = { slug, outletId: created.body.data.outletId, token: login.body.data.accessToken };
    }
  });

  afterAll(async () => { await app?.close(); });

  it('scopes categories to the selected outlet and tax slabs to their tenant', async () => {
    const a = tenants.a;
    const b = tenants.b;
    const aAuth = { ...bearer(a.token), 'x-outlet-id': a.outletId };
    const bAuth = { ...bearer(b.token), 'x-outlet-id': b.outletId };
    const secondOutlet = await http.post('/api/v1/outlets').set(bearer(a.token)).send({ name: 'Second outlet', code: 'SECOND' });
    expect(secondOutlet.status).toBe(201);
    const secondOutletAuth = { ...bearer(a.token), 'x-outlet-id': secondOutlet.body.data.id as string };

    const platformLogin = await http.post('/api/v1/auth/platform/login').send({
      email: config.platformAdminEmail,
      password: config.platformAdminPassword,
    });
    const platformAccess = await http.get('/api/v1/floor/tables')
      .set({ ...bearer(platformLogin.body.data.accessToken), 'x-outlet-id': a.outletId });
    expect(platformAccess.status).toBe(403);

    const missingFloorOutlet = await http.get('/api/v1/floor/tables').set(bearer(a.token));
    expect(missingFloorOutlet.status).toBe(400);
    expect(missingFloorOutlet.body.error.code).toBe('OUTLET_REQUIRED');
    const table = await http.post('/api/v1/floor/tables').set(aAuth).send({
      code: 'T1', name: 'Table 1', section: 'Patio', capacity: 4, sortOrder: 1,
    });
    expect(table.status).toBe(201);
    expect(table.body.data).toMatchObject({ code: 'T1', state: 'AVAILABLE', capacity: 4 });
    const invalidTable = await http.post('/api/v1/floor/tables').set(aAuth).send({
      code: 'T2', name: 'Invalid', capacity: 0,
    });
    expect(invalidTable.status).toBe(400);
    const duplicateTable = await http.post('/api/v1/floor/tables').set(aAuth).send({
      code: 'T1', name: 'Duplicate', capacity: 2,
    });
    expect(duplicateTable.status).toBe(409);
    const tablesForOtherTenant = await http.get('/api/v1/floor/tables').set(bAuth);
    expect(tablesForOtherTenant.body.data).toHaveLength(0);
    const tablesForOtherOutlet = await http.get('/api/v1/floor/tables').set(secondOutletAuth);
    expect(tablesForOtherOutlet.body.data).toHaveLength(0);
    const tableId = table.body.data.id as string;
    const crossOutletTableState = await http.put(`/api/v1/floor/tables/${tableId}/state`)
      .set(secondOutletAuth).send({ state: 'IN_USE' });
    expect(crossOutletTableState.status).toBe(404);
    expect((await http.put(`/api/v1/floor/tables/${tableId}/state`).set(aAuth).send({ state: 'IN_USE' })).status).toBe(200);
    const invalidTableTransition = await http.put(`/api/v1/floor/tables/${tableId}/state`).set(aAuth).send({ state: 'UNAVAILABLE' });
    expect(invalidTableTransition.status).toBe(409);
    expect(invalidTableTransition.body.error.code).toBe('INVALID_TABLE_STATE_TRANSITION');
    const deleteInUseTable = await http.delete(`/api/v1/floor/tables/${tableId}`).set(aAuth);
    expect(deleteInUseTable.status).toBe(409);
    expect(deleteInUseTable.body.error.code).toBe('TABLE_IN_USE');
    await http.put(`/api/v1/floor/tables/${tableId}/state`).set(aAuth).send({ state: 'AVAILABLE' });
    const updateTable = await http.patch(`/api/v1/floor/tables/${tableId}`).set(aAuth).send({ name: 'Patio 1' });
    expect(updateTable.status).toBe(200);
    const deleteTable = await http.delete(`/api/v1/floor/tables/${tableId}`).set(aAuth);
    expect(deleteTable.status).toBe(200);
    expect((await http.get('/api/v1/floor/tables').set(aAuth)).body.data).toHaveLength(0);

    const missingOutlet = await http.get('/api/v1/menu/categories').set(bearer(a.token));
    expect(missingOutlet.status).toBe(400);
    expect(missingOutlet.body.error.code).toBe('OUTLET_REQUIRED');

    const createdCategory = await http.post('/api/v1/menu/categories').set(aAuth).send({ name: 'Starters', sortOrder: 1 });
    expect(createdCategory.status).toBe(201);
    const aCategories = await http.get('/api/v1/menu/categories').set(aAuth);
    expect(aCategories.body.data.map((category: { name: string }) => category.name)).toEqual(['Starters']);
    const secondOutletCategories = await http.get('/api/v1/menu/categories').set(secondOutletAuth);
    expect(secondOutletCategories.body.data).toHaveLength(0);
    const duplicateCategory = await http.post('/api/v1/menu/categories').set(aAuth).send({ name: 'starters' });
    expect(duplicateCategory.status).toBe(409);
    const bCategories = await http.get('/api/v1/menu/categories').set(bAuth);
    expect(bCategories.body.data).toHaveLength(0);

    const wrongOutlet = await http.get('/api/v1/menu/categories').set({ ...bearer(a.token), 'x-outlet-id': b.outletId });
    expect(wrongOutlet.status).toBe(404);

    const taxSlab = await http.post('/api/v1/tax-slabs').set(bearer(a.token)).send({
      code: 'GST_5',
      cgstRate: 250,
      sgstRate: 250,
      igstRate: 500,
      effectiveFrom: '2026-04-01T00:00:00.000Z',
    });
    expect(taxSlab.status).toBe(201);

    const invalidRates = await http.post('/api/v1/tax-slabs').set(bearer(a.token)).send({
      code: 'INVALID',
      cgstRate: 250,
      sgstRate: 250,
      igstRate: 600,
      effectiveFrom: '2026-04-01T00:00:00.000Z',
    });
    expect(invalidRates.status).toBe(400);
    expect(invalidRates.body.error.code).toBe('INVALID_TAX_RATES');

    const categoryId = createdCategory.body.data.id as string;
    const taxSlabId = taxSlab.body.data.id as string;
    const item = await http.post('/api/v1/menu/items').set(aAuth).send({
      categoryId,
      taxSlabId,
      name: 'Paneer Tikka',
      description: 'Smoked paneer',
      dietaryType: 'VEG',
      sku: 'PANEER-TIKKA',
    });
    expect(item.status).toBe(201);
    const itemId = item.body.data.id as string;
    const syncDevice = await http.post('/api/v1/devices').set(bearer(a.token)).send({
      name: 'Sync device', platform: 'windows', outletId: a.outletId,
    });
    expect(syncDevice.status).toBe(201);
    const syncLogin = await http.post('/api/v1/auth/login').send({
      tenantSlug: a.slug, email: `owner@${a.slug}.test`, password: PASSWORD,
      deviceId: syncDevice.body.data.id,
    });
    expect(syncLogin.status).toBe(200);
    const syncAuth = { ...bearer(syncLogin.body.data.accessToken as string), 'x-outlet-id': a.outletId };
    const unboundSync = await http.get('/api/v1/sync/pull?since=0').set(aAuth);
    expect(unboundSync.status).toBe(403);
    expect(unboundSync.body.error.code).toBe('SYNC_DEVICE_REQUIRED');
    const syncEvent = {
      deviceSeq: '1', eventId: randomUUID(), eventType: 'ORDER_CREATE',
      occurredAt: new Date().toISOString(), payload: { clientOrderId: randomUUID(), lines: [] },
    };
    const pushedEvents = await http.post('/api/v1/sync/push').set(syncAuth).send({ events: [syncEvent] });
    expect(pushedEvents.status).toBe(201);
    expect(pushedEvents.body.data.results).toEqual([
      expect.objectContaining({ deviceSeq: '1', eventId: syncEvent.eventId, status: 'RECEIVED', clockSkewWarning: false }),
    ]);
    const replayedEvents = await http.post('/api/v1/sync/push').set(syncAuth).send({ events: [syncEvent] });
    expect(replayedEvents.body.data.results[0].status).toBe('DUPLICATE');
    const conflictingReplay = await http.post('/api/v1/sync/push').set(syncAuth).send({
      events: [{ ...syncEvent, eventId: randomUUID() }],
    });
    expect(conflictingReplay.body.data.results[0]).toMatchObject({ status: 'REJECTED', reason: 'SEQUENCE_OR_EVENT_ID_CONFLICT' });
    const syncInbox = await http.get('/api/v1/sync/events?status=RECEIVED').set(aAuth);
    expect(syncInbox.status).toBe(200);
    expect(syncInbox.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: syncEvent.eventId, eventType: 'ORDER_CREATE', status: 'RECEIVED' }),
    ]));
    const resolveSyncEvent = await http.post(`/api/v1/sync/events/${syncInbox.body.data[0].id}/resolve`).set(aAuth)
      .send({ status: 'RESOLVED', note: 'Reviewed for manual processing' });
    expect(resolveSyncEvent.status).toBe(201);
    const pulledChanges = await http.get('/api/v1/sync/pull?since=0').set(syncAuth);
    expect(pulledChanges.status).toBe(200);
    expect(pulledChanges.body.data.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'categories' }),
      expect.objectContaining({ entityType: 'menu_items' }),
    ]));
    expect(BigInt(pulledChanges.body.data.cursor)).toBeGreaterThan(0n);
    const emptyPull = await http.get(`/api/v1/sync/pull?since=${pulledChanges.body.data.cursor}`).set(syncAuth);
    expect(emptyPull.body.data).toMatchObject({ cursor: pulledChanges.body.data.cursor, hasMore: false, changes: [] });
    const printerStation = await http.post('/api/v1/printer/stations').set(aAuth).send({
      code: 'KITCHEN', name: 'Kitchen Printer',
    });
    expect(printerStation.status).toBe(201);
    expect(printerStation.body.data).toMatchObject({ code: 'KITCHEN', name: 'Kitchen Printer', isActive: true });
    const printerStationId = printerStation.body.data.id as string;
    expect((await http.get('/api/v1/printer/stations').set(bAuth)).body.data).toHaveLength(0);
    const printerRoute = await http.put(`/api/v1/printer/stations/${printerStationId}/categories`).set(aAuth)
      .send({ categoryIds: [categoryId] });
    expect(printerRoute.status).toBe(200);
    const foreignCategoryRoute = await http.put(`/api/v1/printer/stations/${printerStationId}/categories`).set(aAuth)
      .send({ categoryIds: [randomUUID()] });
    expect(foreignCategoryRoute.status).toBe(400);
    expect(foreignCategoryRoute.body.error.code).toBe('CATEGORY_NOT_FOUND');
    const itemWithoutVariant = await http.post('/api/v1/menu/items').set(aAuth).send({
      categoryId,
      taxSlabId,
      name: 'No Variant Item',
      dietaryType: 'VEG',
      sku: 'NO-VARIANT',
    });
    expect(itemWithoutVariant.status).toBe(201);
    const itemWithoutVariantId = itemWithoutVariant.body.data.id as string;
    const stockItem = await http.post('/api/v1/inventory/items').set(aAuth).send({
      name: 'Paneer stock', baseUnit: 'G', reorderLevel: '1.000',
    });
    expect(stockItem.status).toBe(201);
    const stockItemId = stockItem.body.data.id as string;
    expect((await http.get('/api/v1/inventory/items').set(bAuth)).body.data).toHaveLength(0);
    expect((await http.get('/api/v1/inventory/items').set(secondOutletAuth)).body.data).toHaveLength(0);
    const stockReceipt = await http.post(`/api/v1/inventory/items/${stockItemId}/movements`).set(aAuth).send({
      direction: 'IN', quantity: '5.000', reason: 'RECEIPT', reference: 'opening stock',
    });
    expect(stockReceipt.status).toBe(201);
    expect(stockReceipt.body.data).toMatchObject({ delta: '5.000', onHand: '5.000' });
    const insufficientStock = await http.post(`/api/v1/inventory/items/${stockItemId}/movements`).set(aAuth).send({
      direction: 'OUT', quantity: '5.001', reason: 'CONSUMPTION',
    });
    expect(insufficientStock.status).toBe(409);
    expect(insufficientStock.body.error.code).toBe('INSUFFICIENT_STOCK');
    const secondStockItem = await http.post('/api/v1/inventory/items').set(aAuth).send({
      name: 'Spice stock', baseUnit: 'G', reorderLevel: '0.000',
    });
    expect(secondStockItem.status).toBe(201);
    const secondStockItemId = secondStockItem.body.data.id as string;
    const unassignedStockItem = await http.post('/api/v1/inventory/items').set(aAuth).send({
      name: 'Unassigned stock', baseUnit: 'G', reorderLevel: '0.000',
    });
    expect(unassignedStockItem.status).toBe(201);
    const unassignedStockItemId = unassignedStockItem.body.data.id as string;
    const unassignedReceipt = await http.post(`/api/v1/inventory/items/${unassignedStockItemId}/movements`).set(aAuth).send({
      direction: 'IN', quantity: '3.000', reason: 'RECEIPT',
    });
    expect(unassignedReceipt.status).toBe(201);
    const supplier = await http.post('/api/v1/purchasing/suppliers').set(aAuth).send({
      name: 'Local Produce', phone: '1234567890',
    });
    expect(supplier.status).toBe(201);
    const purchaseOrder = await http.post('/api/v1/purchasing/orders').set(aAuth).send({
      supplierId: supplier.body.data.id,
      notes: 'Weekly stock',
      lines: [{ inventoryItemId: unassignedStockItemId, quantity: '2.000', unitCostPaise: '12500' }],
    });
    expect(purchaseOrder.status).toBe(201);
    const purchaseLineId = purchaseOrder.body.data.lines[0].id as string;
    const partialReceipt = await http.post(`/api/v1/purchasing/orders/${purchaseOrder.body.data.id}/receipts`)
      .set(aAuth).send({ reference: 'delivery-1', lines: [{ purchaseOrderLineId: purchaseLineId, quantity: '1.250' }] });
    expect(partialReceipt.status).toBe(201);
    expect(partialReceipt.body.data.status).toBe('PARTIALLY_RECEIVED');
    const overReceipt = await http.post(`/api/v1/purchasing/orders/${purchaseOrder.body.data.id}/receipts`)
      .set(aAuth).send({ lines: [{ purchaseOrderLineId: purchaseLineId, quantity: '0.751' }] });
    expect(overReceipt.status).toBe(400);
    expect(overReceipt.body.error.code).toBe('RECEIPT_EXCEEDS_ORDERED');
    const finalReceipt = await http.post(`/api/v1/purchasing/orders/${purchaseOrder.body.data.id}/receipts`)
      .set(aAuth).send({ lines: [{ purchaseOrderLineId: purchaseLineId, quantity: '0.750' }] });
    expect(finalReceipt.status).toBe(201);
    expect(finalReceipt.body.data.status).toBe('RECEIVED');
    expect((await http.get('/api/v1/purchasing/orders').set(aAuth)).body.data)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: purchaseOrder.body.data.id, status: 'RECEIVED' })]));
    const recipe = await http.put(`/api/v1/inventory/recipes/${itemId}`).set(aAuth).send({
      ingredients: [
        { inventoryItemId: stockItemId, quantity: '0.250' },
        { inventoryItemId: secondStockItemId, quantity: '0.100' },
      ],
    });
    expect(recipe.status).toBe(200);
    expect((await http.get(`/api/v1/inventory/recipes/${itemId}`).set(aAuth)).body.data)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ inventoryItemId: stockItemId, name: 'Paneer stock', quantity: '0.250' }),
        expect.objectContaining({ inventoryItemId: secondStockItemId, name: 'Spice stock', quantity: '0.100' }),
      ]));
    expect((await http.get(`/api/v1/inventory/recipes/${itemId}`).set(secondOutletAuth)).status).toBe(404);
    const taxInUse = await http.delete(`/api/v1/tax-slabs/${taxSlabId}`).set(bearer(a.token));
    expect(taxInUse.status).toBe(409);
    expect(taxInUse.body.error.code).toBe('TAX_SLAB_IN_USE');
    const bItems = await http.get('/api/v1/menu/items').set(bAuth);
    expect(bItems.body.data).toHaveLength(0);
    const categoryInUse = await http.delete(`/api/v1/menu/categories/${categoryId}`).set(aAuth);
    expect(categoryInUse.status).toBe(409);
    expect(categoryInUse.body.error.code).toBe('CATEGORY_IN_USE');

    const baseVariant = await http.post(`/api/v1/menu/items/${itemId}/variants`).set(aAuth).send({
      name: 'Full',
      basePrice: '12500',
      isDefault: true,
    });
    expect(baseVariant.status).toBe(201);
    const variantId = baseVariant.body.data.id as string;
    expect(baseVariant.body.data.basePrice).toBe('12500');
    const noRecipeVariant = await http.post(`/api/v1/menu/items/${itemWithoutVariantId}/variants`).set(aAuth).send({
      name: 'Regular',
      basePrice: '5000',
      isDefault: true,
    });
    expect(noRecipeVariant.status).toBe(201);
    const tooLargePrice = await http.post(`/api/v1/menu/items/${itemId}/variants`).set(aAuth).send({
      name: 'Impossible',
      basePrice: '9223372036854775808',
    });
    expect(tooLargePrice.status).toBe(400);

    const group = await http.post('/api/v1/menu/add-on-groups').set(bearer(a.token)).send({
      name: 'Extras',
      minSelection: 0,
      maxSelection: 2,
      isMandatory: false,
    });
    expect(group.status).toBe(201);
    expect((await http.get('/api/v1/menu/add-on-groups').set(bearer(b.token))).body.data).toHaveLength(0);
    const groupId = group.body.data.id as string;
    const invalidGroup = await http.post('/api/v1/menu/add-on-groups').set(bearer(a.token)).send({
      name: 'Invalid group',
      minSelection: 1,
      maxSelection: 2,
      isMandatory: false,
    });
    expect(invalidGroup.status).toBe(400);
    expect(invalidGroup.body.error.code).toBe('INVALID_ADD_ON_SELECTION');
    const addOn = await http.post(`/api/v1/menu/add-on-groups/${groupId}/add-ons`).set(bearer(a.token)).send({
      name: 'Extra cheese',
      price: '2500',
    });
    expect(addOn.status).toBe(201);
    expect(addOn.body.data.price).toBe('2500');
    const mappedGroups = await http.put(`/api/v1/menu/items/${itemId}/add-on-groups`).set(aAuth).send({ groupIds: [groupId] });
    expect(mappedGroups.status).toBe(200);
    const itemGroups = await http.get(`/api/v1/menu/items/${itemId}/add-on-groups`).set(aAuth);
    expect(itemGroups.body.data).toHaveLength(1);
    expect(itemGroups.body.data[0].addOns).toEqual([
      expect.objectContaining({ name: 'Extra cheese', price: '2500' }),
    ]);

    const basePrice = await http.get(`/api/v1/menu/variants/${variantId}/price?channel=DINE_IN`).set(aAuth);
    expect(basePrice.body.data).toMatchObject({ price: '12500', source: 'base', channel: 'DINE_IN' });
    const outletPrice = await http.put(`/api/v1/menu/variants/${variantId}/price`).set(aAuth).send({ price: '13000' });
    expect(outletPrice.status).toBe(200);
    const resolvedOutletPrice = await http.get(`/api/v1/menu/variants/${variantId}/price`).set(aAuth);
    expect(resolvedOutletPrice.body.data).toMatchObject({ price: '13000', source: 'outlet' });
    const channelPrice = await http.put(`/api/v1/menu/variants/${variantId}/channel-price`).set(aAuth).send({
      channel: 'DINE_IN',
      price: '13500',
    });
    expect(channelPrice.status).toBe(200);
    const resolvedChannelPrice = await http.get(`/api/v1/menu/variants/${variantId}/price?channel=DINE_IN`).set(aAuth);
    expect(resolvedChannelPrice.body.data).toMatchObject({ price: '13500', source: 'channel' });
    const secondOutletPrice = await http.get(`/api/v1/menu/variants/${variantId}/price`).set(secondOutletAuth);
    expect(secondOutletPrice.status).toBe(404);
    const otherTenantPrice = await http.get(`/api/v1/menu/variants/${variantId}/price`).set(bAuth);
    expect(otherTenantPrice.status).toBe(404);

    const activeTable = await http.post('/api/v1/floor/tables').set(aAuth).send({
      code: 'ORDER-T1', name: 'Order Table', capacity: 4,
    });
    expect(activeTable.status).toBe(201);
    const orderTableId = activeTable.body.data.id as string;
    const transferTable = await http.post('/api/v1/floor/tables').set(aAuth).send({
      code: 'ORDER-T2', name: 'Transfer Table', capacity: 4,
    });
    expect(transferTable.status).toBe(201);
    const transferTableId = transferTable.body.data.id as string;
    const missingDineInTable = await http.post('/api/v1/orders').set(aAuth).send({
      orderType: 'DINE_IN', items: [{ variantId, quantity: 1 }],
    });
    expect(missingDineInTable.status).toBe(400);
    const rolledBackOrder = await http.post('/api/v1/orders').set(aAuth).send({
      orderType: 'DINE_IN',
      tableId: orderTableId,
      items: [
        { variantId, quantity: 1 },
        { variantId: randomUUID(), quantity: 1 },
      ],
    });
    expect(rolledBackOrder.status).toBe(400);
    expect((await http.get('/api/v1/floor/tables').set(aAuth))
      .body.data.find((entry: { id: string }) => entry.id === orderTableId).state).toBe('AVAILABLE');
    const order = await http.post('/api/v1/orders').set(aAuth).send({
      orderType: 'DINE_IN',
      tableId: orderTableId,
      notes: 'Window side',
      items: [
        { variantId, quantity: 2, notes: 'No onion', addOnIds: [addOn.body.data.id] },
        { variantId: noRecipeVariant.body.data.id, quantity: 1 },
      ],
    });
    expect(order.status).toBe(201);
    const orderId = order.body.data.id as string;
    expect(order.body.data).toMatchObject({ status: 'OPEN', orderType: 'DINE_IN', tableId: orderTableId });
    const tableInUse = await http.get('/api/v1/floor/tables').set(aAuth);
    expect(tableInUse.body.data.find((entry: { id: string }) => entry.id === orderTableId))
      .toMatchObject({ state: 'IN_USE', activeOrderId: orderId, activeOrderCreatedAt: expect.any(String) });
    const releaseBusyTable = await http.put(`/api/v1/floor/tables/${orderTableId}/state`).set(aAuth).send({ state: 'AVAILABLE' });
    expect(releaseBusyTable.status).toBe(409);
    expect(releaseBusyTable.body.error.code).toBe('TABLE_HAS_ACTIVE_ORDER');
    const holdOrder = await http.post(`/api/v1/orders/${orderId}/hold`).set(aAuth);
    expect(holdOrder.status).toBe(201);
    expect((await http.get(`/api/v1/orders/${orderId}`).set(aAuth)).body.data.status).toBe('HELD');
    const releaseHeldTable = await http.put(`/api/v1/floor/tables/${orderTableId}/state`).set(aAuth).send({ state: 'AVAILABLE' });
    expect(releaseHeldTable.status).toBe(409);
    const heldKot = await http.post(`/api/v1/orders/${orderId}/kot`).set(aAuth);
    expect(heldKot.status).toBe(409);
    expect(heldKot.body.error.code).toBe('ORDER_NOT_ACTIVE');
    const resumeOrder = await http.post(`/api/v1/orders/${orderId}/resume`).set(aAuth);
    expect(resumeOrder.status).toBe(201);
    expect((await http.get(`/api/v1/orders/${orderId}`).set(aAuth)).body.data.status).toBe('OPEN');
    const joinTables = await http.post(`/api/v1/orders/${orderId}/merge-tables`).set(aAuth)
      .send({ tableIds: [transferTableId] });
    expect(joinTables.status).toBe(201);
    const joinedTable = (await http.get('/api/v1/floor/tables').set(aAuth))
      .body.data.find((entry: { id: string }) => entry.id === transferTableId);
    expect(joinedTable).toMatchObject({
      state: 'IN_USE', mergedOrderId: orderId, activeOrderId: orderId, activeOrderCreatedAt: expect.any(String),
    });
    const releaseJoinedTable = await http.put(`/api/v1/floor/tables/${transferTableId}/state`).set(aAuth)
      .send({ state: 'AVAILABLE' });
    expect(releaseJoinedTable.status).toBe(409);
    expect(releaseJoinedTable.body.error.code).toBe('TABLE_HAS_ACTIVE_ORDER');
    const unjoinTables = await http.post(`/api/v1/orders/${orderId}/unmerge-tables`).set(aAuth)
      .send({ tableIds: [transferTableId] });
    expect(unjoinTables.status).toBe(201);
    expect((await http.get('/api/v1/floor/tables').set(aAuth))
      .body.data.find((entry: { id: string }) => entry.id === transferTableId))
      .toMatchObject({ state: 'AVAILABLE', mergedOrderId: null });
    const waiterList = await http.get('/api/v1/orders/waiters').set(aAuth);
    expect(waiterList.status).toBe(200);
    const waiterId = (await http.get('/api/v1/auth/me').set(aAuth)).body.data.userId as string;
    expect(waiterList.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: waiterId })]));
    const assignWaiter = await http.put(`/api/v1/orders/${orderId}/waiter`).set(aAuth).send({ userId: waiterId });
    expect(assignWaiter.status).toBe(200);
    expect((await http.get(`/api/v1/orders/${orderId}`).set(aAuth)).body.data.assignedWaiterId).toBe(waiterId);
    const clearWaiter = await http.put(`/api/v1/orders/${orderId}/waiter`).set(aAuth).send({});
    expect(clearWaiter.status).toBe(200);
    const transferOrder = await http.post(`/api/v1/orders/${orderId}/transfer-table`).set(aAuth)
      .send({ tableId: transferTableId });
    expect(transferOrder.status).toBe(201);
    expect((await http.get(`/api/v1/orders/${orderId}`).set(aAuth)).body.data.tableId).toBe(transferTableId);
    const transferredTables = await http.get('/api/v1/floor/tables').set(aAuth);
    expect(transferredTables.body.data.find((entry: { id: string }) => entry.id === orderTableId).state).toBe('AVAILABLE');
    expect(transferredTables.body.data.find((entry: { id: string }) => entry.id === transferTableId))
      .toMatchObject({ state: 'IN_USE', activeOrderId: orderId, activeOrderCreatedAt: expect.any(String) });
    const joinBeforeBilling = await http.post(`/api/v1/orders/${orderId}/merge-tables`).set(aAuth)
      .send({ tableIds: [orderTableId] });
    expect(joinBeforeBilling.status).toBe(201);
    const otherTenantOrder = await http.get(`/api/v1/orders/${orderId}`).set(bAuth);
    expect(otherTenantOrder.status).toBe(404);
    const orderDetails = await http.get(`/api/v1/orders/${orderId}`).set(aAuth);
    expect(orderDetails.status).toBe(200);
    expect(orderDetails.body.data.items.find((line: { itemName: string }) => line.itemName === 'Paneer Tikka')).toMatchObject({
      itemName: 'Paneer Tikka', variantName: 'Full', quantity: 2, unitPrice: '13500',
      taxCode: 'GST_5', addOns: [expect.objectContaining({ name: 'Extra cheese', price: '2500' })],
    });
    const kot = await http.post(`/api/v1/orders/${orderId}/kot`).set(aAuth);
    expect(kot.status).toBe(201);
    expect(kot.body.data).toMatchObject({
      status: 'QUEUED', itemCount: 2, printing: { queued: 1, routedItems: 2, unroutedItems: 0 },
    });
    expect(typeof kot.body.data.ticketNumber).toBe('string');
    const claimedPrintJobs = await http.post(`/api/v1/printer/stations/${printerStationId}/jobs/claim`).set(aAuth);
    expect(claimedPrintJobs.status).toBe(201);
    expect(claimedPrintJobs.body.data).toHaveLength(1);
    const printJob = claimedPrintJobs.body.data[0];
    expect(printJob.payload).toMatchObject({
      ticketNumber: kot.body.data.ticketNumber,
      orderId,
      items: expect.arrayContaining([expect.objectContaining({ itemName: 'Paneer Tikka', quantity: 2 })]),
    });
    const failPrint = await http.put(`/api/v1/printer/jobs/${printJob.id}/status`).set(aAuth)
      .send({ status: 'FAILED', error: 'Printer offline' });
    expect(failPrint.status).toBe(200);
    const retryPrint = await http.post(`/api/v1/printer/jobs/${printJob.id}/retry`).set(aAuth);
    expect(retryPrint.status).toBe(201);
    const reclaimedPrintJobs = await http.post(`/api/v1/printer/stations/${printerStationId}/jobs/claim`).set(aAuth);
    expect(reclaimedPrintJobs.body.data).toHaveLength(1);
    const completePrint = await http.put(`/api/v1/printer/jobs/${printJob.id}/status`).set(aAuth)
      .send({ status: 'PRINTED' });
    expect(completePrint.status).toBe(200);
    const kitchenQueue = await http.get('/api/v1/orders/kot/queue?status=QUEUED').set(aAuth);
    expect(kitchenQueue.status).toBe(200);
    expect(kitchenQueue.body.data[0]).toMatchObject({
      id: kot.body.data.id, orderId, tableName: 'Transfer Table',
      items: expect.arrayContaining([expect.objectContaining({ itemName: 'Paneer Tikka', quantity: 2 })]),
    });
    const duplicateKot = await http.post(`/api/v1/orders/${orderId}/kot`).set(aAuth);
    expect(duplicateKot.status).toBe(409);
    const inventoryAfterKot = await http.get('/api/v1/inventory/items').set(aAuth);
    expect(inventoryAfterKot.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: stockItemId, onHand: '4.500' }),
      expect.objectContaining({ id: secondStockItemId, onHand: '-0.200' }),
      expect.objectContaining({ id: unassignedStockItemId, onHand: '5.000' }),
    ]));
    const consumedMovements = await http.get(`/api/v1/inventory/items/${stockItemId}/movements`).set(aAuth);
    expect(consumedMovements.body.data.filter((movement: { reason: string }) => movement.reason === 'CONSUMPTION'))
      .toHaveLength(1);
    const beginPreparation = await http.patch(`/api/v1/orders/kot/${kot.body.data.id}/status`).set(aAuth).send({ status: 'PREPARING' });
    expect(beginPreparation.status).toBe(200);
    const readyKot = await http.patch(`/api/v1/orders/kot/${kot.body.data.id}/status`).set(aAuth).send({ status: 'READY' });
    expect(readyKot.status).toBe(200);
    expect((await http.get(`/api/v1/orders/${orderId}`).set(aAuth)).body.data.status).toBe('READY');
    const servedKot = await http.patch(`/api/v1/orders/kot/${kot.body.data.id}/status`).set(aAuth).send({ status: 'SERVED' });
    expect(servedKot.status).toBe(200);
    const invoice = await http.post(`/api/v1/orders/${orderId}/invoice`).set(aAuth).send({
      series: 'A', taxMode: 'INTRA_STATE',
    });
    expect(invoice.status).toBe(201);
    expect(invoice.body.data).toMatchObject({
      invoiceNumber: expect.stringMatching(/^\d{2}-\d{2}\/A\/000001$/),
      taxMode: 'INTRA_STATE', taxableAmount: '35238', cgstAmount: '881',
      sgstAmount: '881', igstAmount: '0', totalTax: '1762', totalAmount: '37000',
      paymentStatus: 'UNPAID',
    });
    const releasedTables = await http.get('/api/v1/floor/tables').set(aAuth);
    expect(releasedTables.body.data.find((entry: { id: string }) => entry.id === orderTableId).state).toBe('AVAILABLE');
    expect(releasedTables.body.data.find((entry: { id: string }) => entry.id === transferTableId).state).toBe('AVAILABLE');
    const dailySales = await http.get('/api/v1/reports/daily-sales').set(aAuth);
    expect(dailySales.status).toBe(200);
    expect(dailySales.body.data.totals).toMatchObject({ invoiceCount: 1, grossSalesPaise: '37000', taxPaise: '1762' });
    expect(dailySales.body.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemName: 'Paneer Tikka', categoryName: 'Starters', quantity: 2, salesPaise: expect.any(String) }),
    ]));
    expect(dailySales.body.data.tax).toEqual(expect.arrayContaining([
      expect.objectContaining({ taxCode: 'GST_5', taxPaise: expect.any(String) }),
    ]));
    expect(dailySales.body.data).toMatchObject({ timezone: expect.any(String), date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    const invalidReportDate = await http.get('/api/v1/reports/daily-sales?date=2026-02-31').set(aAuth);
    expect(invalidReportDate.status).toBe(400);
    expect(invalidReportDate.body.error.code).toBe('INVALID_REPORT_DATE');
    const duplicateInvoice = await http.post(`/api/v1/orders/${orderId}/invoice`).set(aAuth).send({});
    expect(duplicateInvoice.status).toBe(409);
    expect(duplicateInvoice.body.error.code).toBe('ORDER_ALREADY_INVOICED');
    const invoiceForOtherTenant = await http.get(`/api/v1/invoices/${invoice.body.data.id}`).set(bAuth);
    expect(invoiceForOtherTenant.status).toBe(404);
    const invoiceView = await http.get(`/api/v1/invoices/${invoice.body.data.id}`).set(aAuth);
    expect(invoiceView.body.data).toMatchObject({ paidAmount: '0', balanceAmount: '37000', paymentStatus: 'UNPAID' });
    const overpayment = await http.post(`/api/v1/invoices/${invoice.body.data.id}/payments`).set(aAuth).send({
      method: 'CASH', amount: '37001',
    });
    expect(overpayment.status).toBe(400);
    expect(overpayment.body.error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    const firstPayment = await http.post(`/api/v1/invoices/${invoice.body.data.id}/payments`).set(aAuth).send({
      method: 'UPI', amount: '10000', reference: 'upi-ref',
    });
    expect(firstPayment.status).toBe(201);
    const cashWithoutShift = await http.post(`/api/v1/invoices/${invoice.body.data.id}/payments`).set(aAuth).send({
      method: 'CASH', amount: '1',
    });
    expect(cashWithoutShift.status).toBe(409);
    expect(cashWithoutShift.body.error.code).toBe('CASHIER_SHIFT_REQUIRED');
    const openShift = await http.post('/api/v1/cashier-shifts').set(aAuth).send({ openingCash: '10000' });
    expect(openShift.status).toBe(201);
    const shiftId = openShift.body.data.id as string;
    expect(openShift.body.data).toMatchObject({ openingCash: '10000', status: 'OPEN' });
    const duplicateShift = await http.post('/api/v1/cashier-shifts').set(aAuth).send({ openingCash: '0' });
    expect(duplicateShift.status).toBe(409);
    const drawerIn = await http.post(`/api/v1/cashier-shifts/${shiftId}/adjustments`).set(aAuth).send({
      direction: 'IN', amount: '1500', reason: 'Cash float top-up',
    });
    expect(drawerIn.status).toBe(201);
    const drawerOut = await http.post(`/api/v1/cashier-shifts/${shiftId}/adjustments`).set(aAuth).send({
      direction: 'OUT', amount: '500', reason: 'Petty cash',
    });
    expect(drawerOut.status).toBe(201);
    const finalPayment = await http.post(`/api/v1/invoices/${invoice.body.data.id}/payments`).set(aAuth).send({
      method: 'CASH', amount: '27000',
    });
    expect(finalPayment.status).toBe(201);
    expect((await http.get(`/api/v1/invoices/${invoice.body.data.id}`).set(aAuth))
      .body.data).toMatchObject({ paidAmount: '37000', balanceAmount: '0', paymentStatus: 'PAID' });
    const upiRefund = await http.post(`/api/v1/invoices/${invoice.body.data.id}/refunds`).set(aAuth).send({
      paymentId: firstPayment.body.data.id, method: 'UPI', amount: '10000', reason: 'Customer cancelled',
    });
    expect(upiRefund.status).toBe(201);
    const excessRefund = await http.post(`/api/v1/invoices/${invoice.body.data.id}/refunds`).set(aAuth).send({
      paymentId: firstPayment.body.data.id, method: 'UPI', amount: '1', reason: 'Excess refund',
    });
    expect(excessRefund.status).toBe(400);
    expect(excessRefund.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
    const cashRefund = await http.post(`/api/v1/invoices/${invoice.body.data.id}/refunds`).set(aAuth).send({
      paymentId: finalPayment.body.data.id, method: 'CASH', amount: '27000', reason: 'Order cancelled',
    });
    expect(cashRefund.status).toBe(201);
    expect((await http.get(`/api/v1/invoices/${invoice.body.data.id}`).set(aAuth))
      .body.data).toMatchObject({ paidAmount: '0', paymentStatus: 'REFUNDED', refunds: expect.any(Array) });
    const voidInvoice = await http.post(`/api/v1/invoices/${invoice.body.data.id}/void`).set(aAuth).send({
      reason: 'Fully refunded order cancelled',
    });
    expect(voidInvoice.status).toBe(201);
    const payVoidedInvoice = await http.post(`/api/v1/invoices/${invoice.body.data.id}/payments`).set(aAuth).send({
      method: 'UPI', amount: '1',
    });
    expect(payVoidedInvoice.status).toBe(409);
    expect(payVoidedInvoice.body.error.code).toBe('INVOICE_VOIDED');
    const closeShift = await http.post(`/api/v1/cashier-shifts/${shiftId}/close`).set(aAuth).send({ countedCash: '11000' });
    expect(closeShift.status).toBe(201);
    const closedShift = await http.get(`/api/v1/cashier-shifts/${shiftId}`).set(aAuth);
    expect(closedShift.body.data).toMatchObject({
      status: 'CLOSED', openingCash: '10000', expectedCash: '11000', countedCash: '11000', variance: '0',
    });
    const shiftReport = await http.get('/api/v1/cashier-shifts/report').set(aAuth);
    expect(shiftReport.status).toBe(200);
    expect(shiftReport.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: shiftId, netCashPayments: '0', netAdjustments: '1000', expectedCash: '11000' }),
    ]));

    const secondBilledOrder = await http.post('/api/v1/orders').set(aAuth).send({
      orderType: 'TAKEAWAY', items: [{ variantId, quantity: 1 }],
    });
    expect(secondBilledOrder.status).toBe(201);
    const secondKot = await http.post(`/api/v1/orders/${secondBilledOrder.body.data.id}/kot`).set(aAuth);
    expect(secondKot.status).toBe(201);
    await http.patch(`/api/v1/orders/kot/${secondKot.body.data.id}/status`).set(aAuth).send({ status: 'PREPARING' });
    await http.patch(`/api/v1/orders/kot/${secondKot.body.data.id}/status`).set(aAuth).send({ status: 'READY' });
    const secondInvoice = await http.post(`/api/v1/orders/${secondBilledOrder.body.data.id}/invoice`)
      .set(aAuth).send({ taxMode: 'INTER_STATE' });
    expect(secondInvoice.status).toBe(201);
    expect(secondInvoice.body.data.invoiceNumber).toMatch(/^\d{2}-\d{2}\/A\/000002$/);
    expect(secondInvoice.body.data).toMatchObject({ cgstAmount: '0', sgstAmount: '0', igstAmount: '619' });

    async function createReadyOrder(quantity: number) {
      const created = await http.post('/api/v1/orders').set(aAuth).send({
        orderType: 'TAKEAWAY', items: [{ variantId, quantity }],
      });
      expect(created.status).toBe(201);
      const ticket = await http.post(`/api/v1/orders/${created.body.data.id}/kot`).set(aAuth);
      expect(ticket.status).toBe(201);
      await http.patch(`/api/v1/orders/kot/${ticket.body.data.id}/status`).set(aAuth).send({ status: 'PREPARING' });
      await http.patch(`/api/v1/orders/kot/${ticket.body.data.id}/status`).set(aAuth).send({ status: 'READY' });
      return http.get(`/api/v1/orders/${created.body.data.id}`).set(aAuth);
    }
    const defaultBillingSettings = await http.get('/api/v1/billing/settings').set(aAuth);
    expect(defaultBillingSettings.body.data).toMatchObject({
      serviceChargeMode: 'NONE', serviceChargeValue: '0',
    });
    expect(defaultBillingSettings.body.data.taxSlabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GST_5', igstRate: 500 }),
    ]));
    const invalidServiceChargeTax = await http.put('/api/v1/billing/settings').set(aAuth).send({
      serviceChargeMode: 'PERCENTAGE', serviceChargeValue: '10', serviceChargeTaxCode: 'GST_MISSING',
    });
    expect(invalidServiceChargeTax.status).toBe(400);
    expect(invalidServiceChargeTax.body.error.code).toBe('SERVICE_CHARGE_TAX_SLAB_NOT_FOUND');
    const configuredBillingSettings = await http.put('/api/v1/billing/settings').set(aAuth).send({
      serviceChargeMode: 'PERCENTAGE', serviceChargeValue: '10', serviceChargeTaxCode: 'GST_5',
    });
    expect(configuredBillingSettings.status).toBe(200);
    expect(configuredBillingSettings.body.data).toMatchObject({
      serviceChargeMode: 'PERCENTAGE', serviceChargeValue: '10.00', serviceChargeTaxCode: 'GST_5',
    });
    const cashierRole = await http.post('/api/v1/roles').set(aAuth).send({
      name: 'Limited Billing Cashier',
      permissions: [
        { permission: 'bill:create' },
        { permission: 'discount:apply', limits: { maxPercent: 10 } },
      ],
    });
    expect(cashierRole.status).toBe(201);
    const cashierEmail = `billing-cashier-${randomUUID().slice(0, 8)}@${a.slug}.test`;
    const cashierUser = await http.post('/api/v1/users').set(aAuth).send({
      email: cashierEmail, name: 'Billing Cashier', password: PASSWORD,
      assignments: [{ roleId: cashierRole.body.data.id, outletId: a.outletId }],
    });
    expect(cashierUser.status).toBe(201);
    const cashierLogin = await http.post('/api/v1/auth/login').send({
      tenantSlug: a.slug, email: cashierEmail, password: PASSWORD,
    });
    expect(cashierLogin.status).toBe(200);
    const cashierAuth = { ...bearer(cashierLogin.body.data.accessToken), 'x-outlet-id': a.outletId };
    const cashierSettingsWrite = await http.put('/api/v1/billing/settings').set(cashierAuth).send({
      serviceChargeMode: 'NONE', serviceChargeValue: '0',
    });
    expect(cashierSettingsWrite.status).toBe(403);
    const adjustedOrder = await createReadyOrder(1);
    const overLimitPercentage = await http.post(`/api/v1/orders/${adjustedOrder.body.data.id}/invoice`).set(cashierAuth).send({
      taxMode: 'INTRA_STATE', discount: { type: 'PERCENTAGE', value: '10.01' },
    });
    expect(overLimitPercentage.status).toBe(403);
    expect(overLimitPercentage.body.error.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
    const overLimitFixed = await http.post(`/api/v1/orders/${adjustedOrder.body.data.id}/invoice`).set(cashierAuth).send({
      taxMode: 'INTRA_STATE', discount: { type: 'FIXED', value: '1301' },
    });
    expect(overLimitFixed.status).toBe(403);
    expect(overLimitFixed.body.error.code).toBe('DISCOUNT_LIMIT_EXCEEDED');
    const adjustedInvoice = await http.post(`/api/v1/orders/${adjustedOrder.body.data.id}/invoice`).set(cashierAuth).send({
      taxMode: 'INTRA_STATE',
      discount: { type: 'PERCENTAGE', value: '10' },
      tipAmount: '50',
    });
    expect(adjustedInvoice.status).toBe(201);
    expect(adjustedInvoice.body.data).toMatchObject({
      taxableAmount: '12257', cgstAmount: '307', sgstAmount: '306', igstAmount: '0',
      totalTax: '613', discountAmount: '1300', serviceChargeAmount: '1170',
      serviceChargeTax: '56', tipAmount: '50', roundOffAmount: '-20', totalAmount: '12900',
    });
    const adjustedInvoiceView = await http.get(`/api/v1/invoices/${adjustedInvoice.body.data.id}`).set(aAuth);
    expect(adjustedInvoiceView.body.data).toMatchObject({
      discountType: 'PERCENTAGE', discountValue: '1000', discountAmount: '1300',
      serviceChargeTaxCode: 'GST_5', serviceChargeTaxableAmount: '1114',
      serviceChargeTax: '56', tipAmount: '50', roundOffAmount: '-20',
      serviceChargeCgstRate: 250, serviceChargeSgstRate: 250, serviceChargeIgstRate: 500,
      serviceChargeCgstAmount: '28', serviceChargeSgstAmount: '28', serviceChargeIgstAmount: '0',
      balanceAmount: '12900',
      lines: [expect.objectContaining({ discountAmount: '1300', totalAmount: '11700' })],
    });
    const resetBillingSettings = await http.put('/api/v1/billing/settings').set(aAuth).send({
      serviceChargeMode: 'NONE', serviceChargeValue: '0',
    });
    expect(resetBillingSettings.status).toBe(200);
    const adjustedDailySales = await http.get('/api/v1/reports/daily-sales').set(aAuth);
    expect(adjustedDailySales.body.data.totals).toMatchObject({
      invoiceCount: 2, grossSalesPaise: '25900', taxPaise: '1232',
      discountPaise: '1300', serviceChargePaise: '1170', tipPaise: '50', roundOffPaise: '-20',
    });
    expect(adjustedDailySales.body.data.tax).toEqual(expect.arrayContaining([
      expect.objectContaining({ taxCode: 'GST_5', taxPaise: '1232' }),
    ]));

    const mergePrimaryResponse = await createReadyOrder(2);
    const mergeSecondaryResponse = await createReadyOrder(1);
    const mergePrimary = mergePrimaryResponse.body.data;
    const mergeSecondary = mergeSecondaryResponse.body.data;
    const merged = await http.post(`/api/v1/orders/${mergePrimary.id}/merge`).set(aAuth).send({
      orderIds: [mergePrimary.id, mergeSecondary.id],
    });
    expect(merged.status).toBe(201);
    expect(merged.body.data).toMatchObject({ primaryOrderId: mergePrimary.id, orderIds: [mergePrimary.id, mergeSecondary.id] });
    const repeatedMerge = await http.post(`/api/v1/orders/${mergePrimary.id}/merge`).set(aAuth).send({
      orderIds: [mergePrimary.id, mergeSecondary.id],
    });
    expect(repeatedMerge.status).toBe(409);
    expect(repeatedMerge.body.error.code).toBe('ORDER_ALREADY_MERGED');
    const incompleteSplit = await http.post(`/api/v1/orders/${mergePrimary.id}/invoices/split`).set(aAuth).send({
      checks: [{ items: [{ orderItemId: mergePrimary.items[0].id, quantity: 1 }] }, {
        items: [{ orderItemId: mergeSecondary.items[0].id, quantity: 1 }],
      }],
    });
    expect(incompleteSplit.status).toBe(400);
    expect(incompleteSplit.body.error.code).toBe('INCOMPLETE_BILL_SPLIT');
    const splitBilling = await http.post(`/api/v1/orders/${mergePrimary.id}/invoices/split`).set(aAuth).send({
      taxMode: 'INTER_STATE',
      checks: [
        { items: [{ orderItemId: mergePrimary.items[0].id, quantity: 1 }] },
        { items: [
          { orderItemId: mergePrimary.items[0].id, quantity: 1 },
          { orderItemId: mergeSecondary.items[0].id, quantity: 1 },
        ] },
      ],
    });
    expect(splitBilling.status).toBe(201);
    expect(splitBilling.body.data.invoices).toHaveLength(2);
    expect(splitBilling.body.data.invoices.map((bill: { totalAmount: string }) => bill.totalAmount))
      .toEqual(['13000', '26000']);
    const splitInvoice = await http.get(`/api/v1/invoices/${splitBilling.body.data.invoices[1].id}`).set(aAuth);
    expect(splitInvoice.body.data).toMatchObject({
      totalAmount: '26000',
      lines: expect.arrayContaining([
        expect.objectContaining({ quantity: 1, sourceOrderId: mergePrimary.id }),
        expect.objectContaining({ quantity: 1, sourceOrderId: mergeSecondary.id }),
      ]),
    });

    const takeaway = await http.post('/api/v1/orders').set(aAuth).send({
      orderType: 'TAKEAWAY', items: [{ variantId, quantity: 1 }],
    });
    expect(takeaway.status).toBe(201);
    const cancelOrder = await http.post(`/api/v1/orders/${takeaway.body.data.id}/cancel`).set(aAuth);
    expect(cancelOrder.status).toBe(201);
    expect((await http.get(`/api/v1/orders/${takeaway.body.data.id}`).set(aAuth)).body.data.status).toBe('CANCELLED');

    const formulaDescription = await http.patch(`/api/v1/menu/items/${itemId}`).set(aAuth).send({ description: '=2+2' });
    expect(formulaDescription.status).toBe(200);
    const exportedMenu = await http.get('/api/v1/menu/export').set(aAuth);
    expect(exportedMenu.status).toBe(200);
    expect(exportedMenu.body.data).toMatchObject({ itemCount: 2 });
    expect(exportedMenu.body.data.csv).toContain('"Paneer Tikka"');
    expect(exportedMenu.body.data.csv).toContain('"12500"');
    expect(exportedMenu.body.data.csv).toContain(`"'=2+2"`);
    const otherTenantExport = await http.get('/api/v1/menu/export').set(bAuth);
    expect(otherTenantExport.body.data).toMatchObject({ itemCount: 0 });

    const importedMenu = await http.post('/api/v1/menu/import').set(aAuth).send({ csv: exportedMenu.body.data.csv });
    expect(importedMenu.status).toBe(201);
    expect(importedMenu.body.data).toEqual({ created: 0, updated: 2, variantsCreated: 0, variantsUpdated: 2 });
    const itemAfterImport = await http.get('/api/v1/menu/items').set(aAuth);
    expect(itemAfterImport.body.data.find((entry: { id: string }) => entry.id === itemId).description).toBe('=2+2');
    const invalidHeader = await http.post('/api/v1/menu/import').set(aAuth).send({ csv: 'name,sku\n"Bad","BAD"' });
    expect(invalidHeader.status).toBe(400);
    expect(invalidHeader.body.error.code).toBe('INVALID_MENU_CSV_HEADER');

    const header = 'itemId,category,taxCode,name,description,dietaryType,isAvailable,sku,variantName,basePrice,isDefault';
    const rollbackRows = [
      ',"Starters","GST_5","Rolled Back","","VEG","true","ROLLBACK-SKU","","",""',
      ',"Missing Category","GST_5","Invalid Item","","VEG","true","INVALID-SKU","","",""',
    ];
    const atomicImport = await http.post('/api/v1/menu/import').set(aAuth).send({ csv: [header, ...rollbackRows].join('\n') });
    expect(atomicImport.status).toBe(400);
    expect(atomicImport.body.error.code).toBe('MENU_CSV_REFERENCE_NOT_FOUND');
    const itemsAfterRollback = await http.get('/api/v1/menu/items').set(aAuth);
    expect(itemsAfterRollback.body.data).toHaveLength(2);

    const updatedTaxSlab = await http.patch(`/api/v1/tax-slabs/${taxSlabId}`).set(bearer(a.token)).send({
      code: 'GST_6',
      cgstRate: 300,
      sgstRate: 300,
      igstRate: 600,
    });
    expect(updatedTaxSlab.status).toBe(200);
    const aTaxSlabs = await http.get('/api/v1/tax-slabs').set(bearer(a.token));
    expect(aTaxSlabs.body.data.map((slab: { code: string }) => slab.code)).toEqual(['GST_6']);
    const bTaxSlabs = await http.get('/api/v1/tax-slabs').set(bearer(b.token));
    expect(bTaxSlabs.body.data).toHaveLength(0);

    const updatedCategory = await http.patch(`/api/v1/menu/categories/${categoryId}`).set(aAuth).send({ sortOrder: 2 });
    expect(updatedCategory.status).toBe(200);
    const updatedItem = await http.patch(`/api/v1/menu/items/${itemId}`).set(aAuth).send({ isAvailable: false });
    expect(updatedItem.status).toBe(200);
    const deletedItemWithoutVariant = await http.delete(`/api/v1/menu/items/${itemWithoutVariantId}`).set(aAuth);
    expect(deletedItemWithoutVariant.status).toBe(200);
    const deletedItem = await http.delete(`/api/v1/menu/items/${itemId}`).set(aAuth);
    expect(deletedItem.status).toBe(200);
    const deletedCategory = await http.delete(`/api/v1/menu/categories/${categoryId}`).set(aAuth);
    expect(deletedCategory.status).toBe(200);
    expect((await http.get('/api/v1/menu/categories').set(aAuth)).body.data).toHaveLength(0);
    expect((await http.delete(`/api/v1/tax-slabs/${taxSlabId}`).set(bearer(a.token))).status).toBe(200);
    expect((await http.get('/api/v1/tax-slabs').set(bearer(a.token))).body.data).toHaveLength(0);
  });
});
