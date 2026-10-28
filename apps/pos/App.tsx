import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  PosApi, loadSavedConfig, type PosConfig, type PosMenuItem, type PosOrder,
  type PosAddOnGroup, type PosPaymentMethod, type PosShift, type PosTable, type PosVariant, type PosInvoice,
} from './src/api/client';
import { initializeSyncDatabase, localSnapshot, queueLocalOrder, type LocalOrder, type OutboxRow } from './src/sync/database';
import { synchronize, type SyncSummary } from './src/sync/engine';

const initialConfig: PosConfig = {
  apiUrl: 'http://10.0.2.2:3100',
  tenantSlug: '',
  deviceId: '',
  outletId: '',
};
type PricedVariant = PosVariant & { price: string };
type CartLine = {
  key: string; variantId: string; itemName: string; variantName: string; price: string;
  quantity: number; addOnIds: string[]; addOnNames: string[];
};
type AdjustmentForm = { discountType: 'PERCENTAGE' | 'FIXED'; discountValue: string; tipAmount: string };

function formatPaise(value: string) {
  const amount = BigInt(value);
  return `₹${(amount / 100n).toLocaleString('en-IN')}.${String(amount % 100n).padStart(2, '0')}`;
}

function formatSignedPaise(value: string) {
  const amount = BigInt(value);
  if (amount === 0n) return formatPaise('0');
  return amount < 0n ? `- ${formatPaise((-amount).toString())}` : `+ ${formatPaise(value)}`;
}

function validateAdjustment(adjustment: AdjustmentForm) {
  const discount = adjustment.discountValue.trim();
  if (discount) {
    if (adjustment.discountType === 'PERCENTAGE') {
      const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,2}))?$/.exec(discount);
      if (!match) return 'Enter a percentage with up to two decimal places';
      const basisPoints = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
      if (basisPoints < 1n || basisPoints > 10000n) return 'Discount percentage must be greater than zero and no more than 100';
    } else if (!/^[1-9]\d{0,18}$/.test(discount)) {
      return 'Fixed discount must be a positive whole amount in paise';
    }
  }
  if (!/^(0|[1-9]\d{0,18})$/.test(adjustment.tipAmount || '0')) {
    return 'Tip must be a whole amount in paise';
  }
  return null;
}

export default function App() {
  const [config, setConfig] = useState<PosConfig>(initialConfig);
  const [api, setApi] = useState<PosApi | null>(null);
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [orders, setOrders] = useState<LocalOrder[]>([]);
  const [outbox, setOutbox] = useState<OutboxRow[]>([]);
  const [masterCount, setMasterCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncSummary | null>(null);
  const [menuItems, setMenuItems] = useState<PosMenuItem[]>([]);
  const [tables, setTables] = useState<PosTable[]>([]);
  const [waiters, setWaiters] = useState<Awaited<ReturnType<PosApi['waiters']>>>([]);
  const [readyOrders, setReadyOrders] = useState<Awaited<ReturnType<PosApi['orders']>>>([]);
  const [selectedItem, setSelectedItem] = useState<PosMenuItem | null>(null);
  const [variants, setVariants] = useState<PricedVariant[]>([]);
  const [modifierGroups, setModifierGroups] = useState<PosAddOnGroup[]>([]);
  const [selectedAddOnIds, setSelectedAddOnIds] = useState<string[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'>('DINE_IN');
  const [tableId, setTableId] = useState('');
  const [activeOrder, setActiveOrder] = useState<PosOrder | null>(null);
  const [transferTableId, setTransferTableId] = useState('');
  const [invoice, setInvoice] = useState<PosInvoice | null>(null);
  const [invoiceChoices, setInvoiceChoices] = useState<PosInvoice[]>([]);
  const [billOrders, setBillOrders] = useState<PosOrder[]>([]);
  const [invoiceAdjustment, setInvoiceAdjustment] = useState<AdjustmentForm>({
    discountType: 'PERCENTAGE', discountValue: '', tipAmount: '0',
  });
  const [splitAdjustments, setSplitAdjustments] = useState<{ first: AdjustmentForm; second: AdjustmentForm }>({
    first: { discountType: 'PERCENTAGE', discountValue: '', tipAmount: '0' },
    second: { discountType: 'PERCENTAGE', discountValue: '', tipAmount: '0' },
  });
  const [firstCheckQuantities, setFirstCheckQuantities] = useState<Record<string, string>>({});
  const [splitMode, setSplitMode] = useState(false);
  const [selectedMergeOrderIds, setSelectedMergeOrderIds] = useState<string[]>([]);
  const [selectedJoinTableIds, setSelectedJoinTableIds] = useState<string[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PosPaymentMethod>('UPI');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [shift, setShift] = useState<PosShift | null>(null);
  const [openingCash, setOpeningCash] = useState('0');
  const [orderKey, setOrderKey] = useState<string | null>(null);
  const [kotKey, setKotKey] = useState<string | null>(null);
  const [invoiceKey, setInvoiceKey] = useState<string | null>(null);
  const [paymentKey, setPaymentKey] = useState<string | null>(null);
  const [shiftKey, setShiftKey] = useState<string | null>(null);
  const [holdKey, setHoldKey] = useState<string | null>(null);
  const [resumeKey, setResumeKey] = useState<string | null>(null);
  const [mergeKey, setMergeKey] = useState<string | null>(null);
  const [splitKey, setSplitKey] = useState<string | null>(null);
  const [transferKey, setTransferKey] = useState<string | null>(null);
  const [waiterKey, setWaiterKey] = useState<string | null>(null);
  const [joinTablesKey, setJoinTablesKey] = useState<string | null>(null);
  const [unjoinTablesKey, setUnjoinTablesKey] = useState<string | null>(null);

  const pendingCount = useMemo(() => outbox.filter((event) => event.status === 'PENDING').length, [outbox]);
  const rejectedCount = useMemo(() => outbox.filter((event) => event.status === 'REJECTED').length, [outbox]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await initializeSyncDatabase();
        const saved = await loadSavedConfig();
        if (saved && active) {
          const restored = await PosApi.restore(saved);
          setConfig(saved);
          setApi(restored);
          const hasSession = await restored.hasSession();
          setSignedIn(hasSession);
          await reloadSnapshot(saved);
          if (hasSession) {
            await refreshCatalog(restored);
            setShift(await restored.currentShift());
          }
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to open local POS storage');
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => { active = false; };
  }, []);

  async function reloadSnapshot(activeConfig = config) {
    const snapshot = await localSnapshot(activeConfig.deviceId, activeConfig.outletId);
    setOrders(snapshot.orders);
    setOutbox(snapshot.outbox);
    setMasterCount(snapshot.masterCount);
  }

  async function signIn() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
      if (!uuidPattern.test(config.deviceId) || !uuidPattern.test(config.outletId)) {
        throw new Error('Enter the registered device ID and outlet ID from the admin console');
      }
      const client = await PosApi.create(config);
      await client.login(email.trim(), password);
      const identity = await client.me();
      if (identity.kind !== 'tenant' || (identity.outletId && identity.outletId !== config.outletId)) {
        throw new Error('This user is not assigned to the configured restaurant outlet');
      }
      setApi(client);
      setSignedIn(true);
      setPassword('');
      setNotice('Signed in on the registered device.');
      await reloadSnapshot();
      await refreshCatalog(client);
      setShift(await client.currentShift());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  async function refreshCatalog(client = api) {
      if (!client) return;
      const [items, tableRows, orderRows, waiterRows] = await Promise.all([
        client.menuItems(), client.tables(), client.orders(), client.waiters(),
      ]);
      setMenuItems(items.filter((item) => item.isAvailable));
      setTables(tableRows.filter((table) => table.state === 'AVAILABLE' || table.state === 'RESERVED'));
      setReadyOrders(orderRows.filter((order) => order.status === 'READY'));
      setWaiters(waiterRows);
    }

    async function chooseMenuItem(item: PosMenuItem) {
      if (!api) return;
      setError(null);
      setBusy(true);
      try {
        const channel = orderType;
        const [available, groups] = await Promise.all([api.variants(item.id), api.addOnGroups(item.id)]);
        const priced = await Promise.all(available.map(async (variant) => ({
          ...variant,
          price: (await api.variantPrice(variant.id, channel)).price,
        })));
        setSelectedItem(item);
        setVariants(priced);
        setModifierGroups(groups);
        setSelectedAddOnIds([]);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to load menu item variants');
      } finally {
        setBusy(false);
      }
    }

    function addToCart(variant: PricedVariant) {
      if (!selectedItem) return;
      for (const group of modifierGroups) {
        const selectedCount = group.addOns.filter((addOn) => selectedAddOnIds.includes(addOn.id)).length;
        if (selectedCount < group.minSelection || selectedCount > group.maxSelection) {
          setError(`Choose ${group.minSelection}–${group.maxSelection} option(s) for ${group.name}`);
          return;
        }
      }
      const addOns = modifierGroups.flatMap((group) => group.addOns).filter((addOn) => selectedAddOnIds.includes(addOn.id));
      const addOnIds = addOns.map((addOn) => addOn.id).sort();
      const key = `${variant.id}:${addOnIds.join(',')}`;
      const unitPrice = (BigInt(variant.price) + addOns.reduce((sum, addOn) => sum + BigInt(addOn.price), 0n)).toString();
      setCart((current) => {
        const existing = current.find((line) => line.key === key);
        if (existing) return current.map((line) => line.key === key ? { ...line, quantity: line.quantity + 1 } : line);
        return [...current, {
          key, variantId: variant.id, itemName: selectedItem.name, variantName: variant.name,
          price: unitPrice, quantity: 1, addOnIds, addOnNames: addOns.map((addOn) => addOn.name),
        }];
      });
      setError(null);
    }

    function toggleAddOn(group: PosAddOnGroup, addOnId: string) {
      const selected = selectedAddOnIds.includes(addOnId);
      if (selected) {
        setSelectedAddOnIds((current) => current.filter((id) => id !== addOnId));
        setError(null);
        return;
      }
      const count = group.addOns.filter((addOn) => selectedAddOnIds.includes(addOn.id)).length;
      if (count >= group.maxSelection) {
        setError(`Choose no more than ${group.maxSelection} option(s) for ${group.name}`);
        return;
      }
      setSelectedAddOnIds((current) => [...current, addOnId]);
      setError(null);
    }

    async function submitOrder() {
      if (!api) return;
      if (!cart.length) { setError('Add at least one menu item before creating an order'); return; }
      if (orderType === 'DINE_IN' && !tableId) { setError('Choose a table for a dine-in order'); return; }
      setError(null);
      setNotice(null);
      setBusy(true);
      try {
        const requestKey = orderKey ?? Crypto.randomUUID();
        setOrderKey(requestKey);
        const order = await api.createOrder({
          orderType,
          ...(orderType === 'DINE_IN' ? { tableId } : {}),
          items: cart.map(({ variantId, quantity, addOnIds }) => ({ variantId, quantity, addOnIds })),
        }, requestKey);
        setOrderKey(null);
        setActiveOrder({
          ...order, tableId: orderType === 'DINE_IN' ? tableId : null,
          billingGroupId: null, assignedWaiterId: null, items: [], joinedTables: [], kotTickets: [],
        });
        setInvoice(null);
        setInvoiceChoices([]);
        setSplitMode(false);
        setCart([]);
        setNotice(`Order ${order.id.slice(0, 8)} created. Sending kitchen ticket…`);
        try {
          const kotRequestKey = kotKey ?? Crypto.randomUUID();
          setKotKey(kotRequestKey);
          const ticket = await api.sendKot(order.id, kotRequestKey);
          setKotKey(null);
          setActiveOrder((current) => current ? {
            ...current, status: 'IN_PROGRESS', kotTickets: [{ id: ticket.id, status: ticket.status }],
          } : current);
          const detail = await api.order(order.id);
          setActiveOrder(detail);
          setNotice(`Kitchen ticket sent for order ${order.id.slice(0, 8)}.`);
          await refreshCatalog();
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Order was created but the kitchen ticket could not be sent');
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to create order');
      } finally {
        setBusy(false);
      }
    }

    async function refreshActiveOrder() {
      if (!api || !activeOrder) return;
      setError(null);
      setBusy(true);
      try {
        const detail = await api.order(activeOrder.id);
        setActiveOrder(detail);
        await refreshCatalog();
        setNotice(`Order status: ${detail.status}.`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to refresh order status');
      } finally {
        setBusy(false);
      }
    }

    async function mergeReadyOrders() {
      if (!api || !activeOrder) return;
      const orderIds = [...new Set([activeOrder.id, ...selectedMergeOrderIds])];
      if (orderIds.length < 2) { setError('Choose at least one other ready order to merge'); return; }
      setError(null);
      setBusy(true);
      try {
        const requestKey = mergeKey ?? Crypto.randomUUID();
        setMergeKey(requestKey);
        await api.mergeOrders(activeOrder.id, orderIds, requestKey);
        setMergeKey(null);
        setSelectedMergeOrderIds([]);
        setActiveOrder(await api.order(activeOrder.id));
        await refreshCatalog();
        setNotice(`${orderIds.length} ready orders merged for billing.`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to merge orders for billing');
      } finally {
        setBusy(false);
      }
    }

    async function transferActiveOrder() {
      if (!api || !activeOrder || !transferTableId) return;
      setError(null);
      setBusy(true);
      try {
        const requestKey = transferKey ?? Crypto.randomUUID();
        setTransferKey(requestKey);
        await api.transferOrderTable(activeOrder.id, transferTableId, requestKey);
        setTransferKey(null);
        setActiveOrder(await api.order(activeOrder.id));
        setTransferTableId('');
        await refreshCatalog();
        setNotice('Order transferred to the selected table.');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to transfer order to another table');
      } finally {
        setBusy(false);
      }
    }

    async function setOrderWaiter(waiterId: string | null) {
        if (!api || !activeOrder) return;
        setError(null);
        setBusy(true);
        try {
          const requestKey = waiterKey ?? Crypto.randomUUID();
          setWaiterKey(requestKey);
          await api.assignWaiter(activeOrder.id, waiterId, requestKey);
          setWaiterKey(null);
          setActiveOrder(await api.order(activeOrder.id));
          setNotice(waiterId ? 'Waiter assigned to this order.' : 'Waiter assignment cleared.');
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Unable to update waiter assignment');
        } finally {
          setBusy(false);
        }
    }

    async function joinSelectedTables() {
        if (!api || !activeOrder || !selectedJoinTableIds.length) return;
        setError(null);
        setBusy(true);
        try {
          const requestKey = joinTablesKey ?? Crypto.randomUUID();
          setJoinTablesKey(requestKey);
          await api.mergeTables(activeOrder.id, selectedJoinTableIds, requestKey);
          setJoinTablesKey(null);
          setSelectedJoinTableIds([]);
          setActiveOrder(await api.order(activeOrder.id));
          await refreshCatalog();
          setNotice('Additional tables joined to this order.');
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Unable to join tables to this order');
        } finally {
          setBusy(false);
        }
    }

    async function unjoinTable(tableId: string) {
        if (!api || !activeOrder) return;
        setError(null);
        setBusy(true);
        try {
          const requestKey = unjoinTablesKey ?? Crypto.randomUUID();
          setUnjoinTablesKey(requestKey);
          await api.unmergeTables(activeOrder.id, [tableId], requestKey);
          setUnjoinTablesKey(null);
          setActiveOrder(await api.order(activeOrder.id));
          await refreshCatalog();
          setNotice('Additional table released.');
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Unable to release the additional table');
        } finally {
          setBusy(false);
      }
    }

    async function beginBillSplit() {
      if (!api || !activeOrder) return;
      setError(null);
      setBusy(true);
      try {
        const relatedOrderIds = activeOrder.billingGroupId
          ? readyOrders.filter((order) => order.billingGroupId === activeOrder.billingGroupId).map((order) => order.id)
          : [activeOrder.id];
        if (!relatedOrderIds.includes(activeOrder.id)) relatedOrderIds.push(activeOrder.id);
        const details = await Promise.all(relatedOrderIds.map((id) => api.order(id)));
        const lines = details.flatMap((order) => order.items);
        if (lines.reduce((total, line) => total + line.quantity, 0) < 2) {
          throw new Error('At least two item quantities are needed to split a bill');
        }
        const firstItemId = lines[0]?.id;
        setBillOrders(details);
        setFirstCheckQuantities(Object.fromEntries(lines.map((line) => [line.id, line.id === firstItemId ? '1' : '0'])));
        setSplitAdjustments({
          first: { discountType: 'PERCENTAGE', discountValue: '', tipAmount: '0' },
          second: { discountType: 'PERCENTAGE', discountValue: '', tipAmount: '0' },
        });
        setSplitMode(true);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to load order items for splitting');
      } finally {
        setBusy(false);
      }
    }

    async function splitActiveBill() {
      if (!api || !activeOrder) return;
      const lines = billOrders.flatMap((order) => order.items);
      const firstCheck: { orderItemId: string; quantity: number }[] = [];
      const secondCheck: { orderItemId: string; quantity: number }[] = [];
      for (const line of lines) {
        const rawQuantity = firstCheckQuantities[line.id] ?? '0';
        if (!/^(0|[1-9]\d*)$/.test(rawQuantity)) {
          setError(`Enter a whole quantity for ${line.itemName}`);
          return;
        }
        const firstQuantity = Number(rawQuantity);
        if (!Number.isSafeInteger(firstQuantity) || firstQuantity > line.quantity) {
          setError(`The split quantity for ${line.itemName} cannot exceed ${line.quantity}`);
          return;
        }
        if (firstQuantity) firstCheck.push({ orderItemId: line.id, quantity: firstQuantity });
        if (line.quantity - firstQuantity) secondCheck.push({ orderItemId: line.id, quantity: line.quantity - firstQuantity });
      }
      if (!firstCheck.length || !secondCheck.length) {
        setError('Both checks need at least one item quantity');
        return;
      }
      const firstAdjustmentError = validateAdjustment(splitAdjustments.first);
      const secondAdjustmentError = validateAdjustment(splitAdjustments.second);
      if (firstAdjustmentError || secondAdjustmentError) {
        setError(firstAdjustmentError ?? secondAdjustmentError);
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const requestKey = splitKey ?? Crypto.randomUUID();
        setSplitKey(requestKey);
        const result = await api.splitInvoices(activeOrder.id, [
          {
            items: firstCheck,
            ...(splitAdjustments.first.discountValue.trim()
              ? { discount: { type: splitAdjustments.first.discountType, value: splitAdjustments.first.discountValue.trim() } }
              : {}),
            tipAmount: splitAdjustments.first.tipAmount || '0',
          },
          {
            items: secondCheck,
            ...(splitAdjustments.second.discountValue.trim()
              ? { discount: { type: splitAdjustments.second.discountType, value: splitAdjustments.second.discountValue.trim() } }
              : {}),
            tipAmount: splitAdjustments.second.tipAmount || '0',
          },
        ], requestKey);
        setSplitKey(null);
        const created = await Promise.all(result.invoices.map((bill) => api.invoice(bill.id)));
        setInvoiceChoices(created);
        setInvoice(created[0] ?? null);
        setPaymentAmount(created[0]?.balanceAmount ?? '');
        setSplitMode(false);
        setActiveOrder(await api.order(activeOrder.id));
        await refreshCatalog();
        setNotice(`${created.length} split invoices finalized.`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to split the bill');
      } finally {
        setBusy(false);
      }
    }

    async function finalizeActiveOrder() {
      if (!api || !activeOrder) return;
      const adjustmentError = validateAdjustment(invoiceAdjustment);
      if (adjustmentError) { setError(adjustmentError); return; }
      setError(null);
      setBusy(true);
      try {
        const requestKey = invoiceKey ?? Crypto.randomUUID();
        setInvoiceKey(requestKey);
        const created = await api.finalizeInvoice(activeOrder.id, requestKey, {
          ...(invoiceAdjustment.discountValue.trim()
            ? { discount: { type: invoiceAdjustment.discountType, value: invoiceAdjustment.discountValue.trim() } }
            : {}),
          tipAmount: invoiceAdjustment.tipAmount || '0',
        });
        setInvoiceKey(null);
        const finalized = await api.invoice(created.id);
        setInvoice(finalized);
        setInvoiceChoices([finalized]);
        setPaymentAmount(finalized.balanceAmount);
        await refreshCatalog();
        setNotice(`Invoice ${created.invoiceNumber} finalized.`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to finalize invoice');
      } finally {
        setBusy(false);
      }
    }

    async function refreshInvoice() {
      if (!api || !invoice) return;
      setError(null);
      setBusy(true);
      try {
        const current = await api.invoice(invoice.id);
        setInvoice(current);
        setInvoiceChoices((choices) => choices.map((choice) => choice.id === current.id ? current : choice));
        setPaymentAmount(current.balanceAmount);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to refresh invoice');
      } finally {
        setBusy(false);
      }
    }

    async function payInvoice() {
      if (!api || !invoice) return;
      if (!/^[1-9]\d{0,18}$/.test(paymentAmount)) { setError('Payment amount must be a positive whole number of paise'); return; }
      setError(null);
      setBusy(true);
      try {
        const requestKey = paymentKey ?? Crypto.randomUUID();
        setPaymentKey(requestKey);
        await api.recordPayment(invoice.id, paymentMethod, paymentAmount, requestKey);
        setPaymentKey(null);
        const updated = await api.invoice(invoice.id);
        setInvoice(updated);
        setInvoiceChoices((choices) => choices.map((choice) => choice.id === updated.id ? updated : choice));
        setPaymentAmount(updated.balanceAmount);
        setNotice('Payment recorded.');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to record payment');
      } finally {
        setBusy(false);
      }
    }

    async function beginShift() {
      if (!api) return;
      if (!/^(0|[1-9]\d{0,18})$/.test(openingCash)) { setError('Opening cash must be a whole amount in paise'); return; }
      setError(null);
      setBusy(true);
      try {
        const requestKey = shiftKey ?? Crypto.randomUUID();
        setShiftKey(requestKey);
        setShift(await api.openShift(openingCash, requestKey));
        setShiftKey(null);
        setNotice('Cashier shift opened.');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Unable to open cashier shift');
      } finally {
        setBusy(false);
      }
  }

  async function retryKot() {
    if (!api || !activeOrder) return;
    setError(null);
    setBusy(true);
    try {
      const requestKey = kotKey ?? Crypto.randomUUID();
      setKotKey(requestKey);
      const ticket = await api.sendKot(activeOrder.id, requestKey);
      setKotKey(null);
      setActiveOrder((current) => current ? {
        ...current, status: 'IN_PROGRESS', kotTickets: [{ id: ticket.id, status: ticket.status }],
      } : current);
      setActiveOrder(await api.order(activeOrder.id));
      setNotice('Kitchen ticket sent.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to send kitchen ticket');
    } finally {
      setBusy(false);
    }
  }

  async function toggleHold() {
    if (!api || !activeOrder) return;
    setError(null);
    setBusy(true);
    try {
      if (activeOrder.status === 'HELD') {
        const requestKey = resumeKey ?? Crypto.randomUUID();
        setResumeKey(requestKey);
        await api.resumeOrder(activeOrder.id, requestKey);
        setResumeKey(null);
      } else {
        const requestKey = holdKey ?? Crypto.randomUUID();
        setHoldKey(requestKey);
        await api.holdOrder(activeOrder.id, requestKey);
        setHoldKey(null);
      }
      setActiveOrder(await api.order(activeOrder.id));
      setNotice(`Order ${activeOrder.status === 'HELD' ? 'resumed' : 'held'}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to change order hold status');
    } finally {
      setBusy(false);
    }
  }

  async function addLocalOrder() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await queueLocalOrder(config.deviceId, config.outletId, itemName, Number(quantity));
      setItemName('');
      setQuantity('1');
      setNotice(`Saved locally as order ${result.order.id.slice(0, 8)}. It is queued for sync.`);
      await reloadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the local order');
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    if (!api) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const summary = await synchronize(api, config.deviceId, config.outletId);
      setLastSync(summary);
      setNotice(`Sync complete: ${summary.received} received, ${summary.duplicates} already received, ${summary.rejected} rejected, ${summary.changes} master-data changes.`);
      await reloadSnapshot();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sync failed; queued events remain available for retry');
      await reloadSnapshot();
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!api) return;
    setError(null);
    setBusy(true);
    try {
      await api.logout();
      setApi(null);
      setSignedIn(false);
      setMenuItems([]);
      setTables([]);
      setSelectedItem(null);
      setVariants([]);
      setModifierGroups([]);
      setSelectedAddOnIds([]);
      setCart([]);
      setActiveOrder(null);
      setInvoice(null);
      setInvoiceChoices([]);
      setBillOrders([]);
      setSplitMode(false);
      setSelectedMergeOrderIds([]);
      setSelectedJoinTableIds([]);
      setTransferTableId('');
      setReadyOrders([]);
      setWaiters([]);
      setShift(null);
      setNotice('Signed out.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to end the server session');
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return <View style={styles.center}><Text style={styles.title}>Opening local POS storage…</Text></View>;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>RMS · RESTAURANT POS</Text>
        <Text style={styles.title}>Point of sale</Text>
        <Text style={styles.description}>
          Create live orders from the outlet menu, send kitchen tickets, finalize invoices, and record payments. Offline events remain in a separate manual-review inbox.
        </Text>

        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {notice && <Text accessibilityRole="summary" style={styles.notice}>{notice}</Text>}

        {!signedIn ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Connect a registered device</Text>
            <Text style={styles.hint}>Register the device in Restaurant Admin first. Use the same outlet as the device registration.</Text>
            <Input label="API origin" value={config.apiUrl} onChangeText={(apiUrl) => setConfig({ ...config, apiUrl })} autoCapitalize="none" />
            <Input label="Restaurant tenant slug" value={config.tenantSlug} onChangeText={(tenantSlug) => setConfig({ ...config, tenantSlug })} autoCapitalize="none" />
            <Input label="Registered device ID" value={config.deviceId} onChangeText={(deviceId) => setConfig({ ...config, deviceId })} autoCapitalize="none" />
            <Input label="Outlet ID" value={config.outletId} onChangeText={(outletId) => setConfig({ ...config, outletId })} autoCapitalize="none" />
            <Input label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry />
            <ActionButton title={busy ? 'Signing in…' : 'Sign in'} onPress={signIn} disabled={busy || !email.trim() || !password} />
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>New order</Text>
              <View style={styles.row}>
                {(['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const).map((type) => (
                  <ActionButton key={type} title={type.replace('_', ' ')} variant={orderType === type ? 'primary' : 'secondary'} onPress={() => setOrderType(type)} disabled={busy} />
                ))}
              </View>
              {orderType === 'DINE_IN' && (
                <View style={styles.field}>
                  <Text style={styles.label}>Available tables</Text>
                  <View style={styles.row}>
                    {tables.map((table) => (
                      <ActionButton key={table.id} title={`${table.name} · ${table.capacity}`} variant={tableId === table.id ? 'primary' : 'secondary'} onPress={() => setTableId(table.id)} disabled={busy} />
                    ))}
                    {!tables.length && <Text style={styles.hint}>No available tables. Refresh the outlet setup from Restaurant Admin.</Text>}
                  </View>
                </View>
              )}
              <View style={styles.field}>
                <Text style={styles.label}>Menu · {menuItems.length} available items</Text>
                {menuItems.length ? menuItems.map((item) => (
                  <Pressable key={item.id} accessibilityRole="button" onPress={() => { void chooseMenuItem(item); }} style={styles.listRow} disabled={busy}>
                    <View style={styles.flex}><Text style={styles.listTitle}>{item.name}</Text><Text style={styles.hint}>{item.categoryName} · {item.dietaryType.replace('_', ' ')}</Text></View>
                    <Text style={styles.hint}>Choose</Text>
                  </Pressable>
                )) : <Text style={styles.hint}>No menu items are available at this outlet.</Text>}
              </View>
              {selectedItem && <View style={styles.field}>
                <Text style={styles.label}>Variants · {selectedItem.name}</Text>
                {variants.map((variant) => (
                  <View key={variant.id} style={styles.listRow}>
                    <View style={styles.flex}><Text style={styles.listTitle}>{variant.name}{variant.isDefault ? ' · default' : ''}</Text><Text style={styles.hint}>{formatPaise(variant.price)}</Text></View>
                    <ActionButton title="Add" onPress={() => addToCart(variant)} disabled={busy} />
                  </View>
                ))}
                {!variants.length && <Text style={styles.hint}>This menu item has no variants and cannot be ordered.</Text>}
                {modifierGroups.map((group) => (
                  <View key={group.id} style={styles.field}>
                    <Text style={styles.label}>{group.name} · choose {group.minSelection}–{group.maxSelection}</Text>
                    {group.addOns.map((addOn) => {
                      const selected = selectedAddOnIds.includes(addOn.id);
                      return <Pressable key={addOn.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => toggleAddOn(group, addOn.id)} style={styles.listRow}>
                        <Text style={styles.listTitle}>{selected ? '✓ ' : ''}{addOn.name}</Text>
                        <Text style={styles.hint}>+ {formatPaise(addOn.price)}</Text>
                      </Pressable>;
                    })}
                  </View>
                ))}
              </View>}
              <View style={styles.field}>
                <Text style={styles.label}>Cart</Text>
                {cart.map((line) => <View key={line.key} style={styles.listRow}>
                  <View style={styles.flex}><Text style={styles.listTitle}>{line.quantity} × {line.itemName} · {line.variantName}</Text><Text style={styles.hint}>{line.addOnNames.length ? `+ ${line.addOnNames.join(', ')} · ` : ''}{formatPaise((BigInt(line.price) * BigInt(line.quantity)).toString())}</Text></View>
                  <ActionButton title="Remove" variant="secondary" onPress={() => setCart((current) => current.filter((entry) => entry.key !== line.key))} />
                </View>)}
                {!cart.length && <Text style={styles.hint}>Cart is empty.</Text>}
              </View>
              <ActionButton title={busy ? 'Creating…' : `Create order${cart.length ? ` · ${formatPaise(cart.reduce((sum, line) => sum + BigInt(line.price) * BigInt(line.quantity), 0n).toString())}` : ''}`} onPress={submitOrder} disabled={busy || !cart.length || (orderType === 'DINE_IN' && !tableId)} />
            </View>

            {activeOrder && <View style={styles.card}>
              <Text style={styles.sectionTitle}>Order {activeOrder.id.slice(0, 8)}</Text>
              <Text style={styles.hint}>{activeOrder.orderType.replace('_', ' ')} · {activeOrder.status}</Text>
              {activeOrder.orderType === 'DINE_IN' && !activeOrder.joinedTables.length
                && ['OPEN', 'HELD', 'IN_PROGRESS', 'READY'].includes(activeOrder.status) && <View style={styles.field}>
                <Text style={styles.label}>Transfer to another table</Text>
                <View style={styles.row}>
                  {tables.filter((table) => table.id !== activeOrder.tableId).map((table) => (
                    <ActionButton key={table.id} title={table.name} variant={transferTableId === table.id ? 'primary' : 'secondary'}
                      onPress={() => setTransferTableId(table.id)} disabled={busy} />
                  ))}
                  {!tables.some((table) => table.id !== activeOrder.tableId)
                    && <Text style={styles.hint}>No other available tables.</Text>}
                </View>
                <ActionButton title="Transfer order" variant="secondary" onPress={transferActiveOrder}
                  disabled={busy || !transferTableId} />
              </View>}
              {['OPEN', 'HELD', 'IN_PROGRESS', 'READY'].includes(activeOrder.status) && <View style={styles.field}>
                <Text style={styles.label}>Waiter assignment</Text>
                <Text style={styles.hint}>{waiters.find((waiter) => waiter.id === activeOrder.assignedWaiterId)?.name ?? 'No waiter assigned'}</Text>
                <View style={styles.row}>
                  {waiters.map((waiter) => <ActionButton key={waiter.id} title={waiter.name}
                    variant={activeOrder.assignedWaiterId === waiter.id ? 'primary' : 'secondary'}
                    onPress={() => setOrderWaiter(waiter.id)} disabled={busy} />)}
                  {activeOrder.assignedWaiterId && <ActionButton title="Clear" variant="secondary"
                    onPress={() => setOrderWaiter(null)} disabled={busy} />}
                  {!waiters.length && <Text style={styles.hint}>No active outlet users are assigned.</Text>}
                </View>
              </View>}
              {activeOrder.orderType === 'DINE_IN' && ['OPEN', 'HELD', 'IN_PROGRESS', 'READY'].includes(activeOrder.status) && <View style={styles.field}>
                <Text style={styles.label}>Joined tables</Text>
                {activeOrder.joinedTables.map((table) => <View key={table.id} style={styles.listRow}>
                  <Text style={styles.listTitle}>{table.name} · {table.capacity} seats</Text>
                  <ActionButton title="Unjoin" variant="secondary" onPress={() => unjoinTable(table.id)} disabled={busy} />
                </View>)}
                <Text style={styles.hint}>Join available tables to increase seating for this order.</Text>
                <View style={styles.row}>
                  {tables.filter((table) => table.id !== activeOrder.tableId).map((table) => {
                    const selected = selectedJoinTableIds.includes(table.id);
                    return <Pressable key={table.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
                      onPress={() => setSelectedJoinTableIds((current) => selected
                        ? current.filter((id) => id !== table.id) : [...current, table.id])}
                      style={styles.listRow} disabled={busy}>
                      <Text style={styles.listTitle}>{selected ? '✓ ' : ''}{table.name} · {table.capacity} seats</Text>
                    </Pressable>;
                  })}
                  {!tables.some((table) => table.id !== activeOrder.tableId) && <Text style={styles.hint}>No additional tables are available.</Text>}
                </View>
                <ActionButton title="Join selected tables" variant="secondary" onPress={joinSelectedTables}
                  disabled={busy || !selectedJoinTableIds.length} />
              </View>}
              {activeOrder.kotTickets.map((ticket) => <Text key={ticket.id} style={styles.hint}>Kitchen ticket · {ticket.status}</Text>)}
              {activeOrder.status === 'READY' && !invoice && !splitMode && <View style={styles.field}>
                <Text style={styles.label}>Bill adjustment</Text>
                <View style={styles.row}>
                  <ActionButton title="Percent discount" variant={invoiceAdjustment.discountType === 'PERCENTAGE' ? 'primary' : 'secondary'}
                    onPress={() => setInvoiceAdjustment((current) => ({ ...current, discountType: 'PERCENTAGE' }))} disabled={busy} />
                  <ActionButton title="Fixed discount" variant={invoiceAdjustment.discountType === 'FIXED' ? 'primary' : 'secondary'}
                    onPress={() => setInvoiceAdjustment((current) => ({ ...current, discountType: 'FIXED' }))} disabled={busy} />
                </View>
                <Input
                  label={invoiceAdjustment.discountType === 'PERCENTAGE' ? 'Discount percent' : 'Discount (paise)'}
                  value={invoiceAdjustment.discountValue}
                  onChangeText={(value) => setInvoiceAdjustment((current) => ({ ...current, discountValue: value }))}
                  keyboardType={invoiceAdjustment.discountType === 'PERCENTAGE' ? 'decimal-pad' : 'number-pad'}
                />
                <Input label="Tip (paise, optional)" value={invoiceAdjustment.tipAmount}
                  onChangeText={(value) => setInvoiceAdjustment((current) => ({ ...current, tipAmount: value }))}
                  keyboardType="number-pad" />
                <Text style={styles.hint}>Discount is applied before GST. Configured service charge, if enabled, is applied after discount. Tip is non-taxable; total rounds to the nearest rupee.</Text>
              </View>}
              <View style={styles.row}>
                {!activeOrder.kotTickets.length && activeOrder.status === 'OPEN' && <ActionButton title="Send kitchen ticket" onPress={retryKot} disabled={busy} />}
                {!activeOrder.kotTickets.length && ['OPEN', 'HELD'].includes(activeOrder.status) && <ActionButton title={activeOrder.status === 'HELD' ? 'Resume order' : 'Hold order'} variant="secondary" onPress={toggleHold} disabled={busy} />}
                <ActionButton title="Refresh order" variant="secondary" onPress={refreshActiveOrder} disabled={busy} />
                {activeOrder.status === 'READY' && !invoice && <ActionButton title="Finalize invoice" onPress={finalizeActiveOrder} disabled={busy} />}
                {activeOrder.status === 'READY' && !invoice && <ActionButton title="Split bill" variant="secondary" onPress={beginBillSplit} disabled={busy} />}
              </View>
              {activeOrder.status === 'READY' && !invoice && !activeOrder.billingGroupId && <View style={styles.field}>
                <Text style={styles.label}>Merge another ready order into this bill</Text>
                {readyOrders.filter((order) => order.id !== activeOrder.id && !order.billingGroupId && order.orderType === activeOrder.orderType).map((order) => {
                  const selected = selectedMergeOrderIds.includes(order.id);
                  return <Pressable key={order.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
                    onPress={() => setSelectedMergeOrderIds((current) => selected
                      ? current.filter((id) => id !== order.id) : [...current, order.id])}
                    style={styles.listRow} disabled={busy}>
                    <Text style={styles.listTitle}>{selected ? '✓ ' : ''}{order.orderType.replace('_', ' ')} · {order.id.slice(0, 8)}</Text>
                    <Text style={styles.hint}>{selected ? 'Selected' : 'Select'}</Text>
                  </Pressable>;
                })}
                {!readyOrders.some((order) => order.id !== activeOrder.id && !order.billingGroupId && order.orderType === activeOrder.orderType)
                  && <Text style={styles.hint}>No other ready, unbilled orders of this type.</Text>}
                <ActionButton title={`Merge ${selectedMergeOrderIds.length ? selectedMergeOrderIds.length + 1 : ''} order(s)`}
                  variant="secondary" onPress={mergeReadyOrders} disabled={busy || !selectedMergeOrderIds.length} />
              </View>}
              {activeOrder.billingGroupId && <Text style={styles.hint}>This order is merged with other ready orders for a combined bill.</Text>}
              {splitMode && <View style={styles.field}>
                <Text style={styles.label}>Split into two checks</Text>
                <Text style={styles.hint}>Set the quantity on check 1. Remaining quantities go to check 2.</Text>
                {billOrders.flatMap((order) => order.items.map((line) => ({ ...line, orderId: order.id }))).map((line) => (
                  <View key={line.id} style={styles.listRow}>
                    <View style={styles.flex}>
                      <Text style={styles.listTitle}>{line.itemName} · {line.variantName}</Text>
                      <Text style={styles.hint}>Order {line.orderId.slice(0, 8)} · total qty {line.quantity}</Text>
                    </View>
                    <Input label="Check 1 qty" value={firstCheckQuantities[line.id] ?? '0'}
                      onChangeText={(value) => setFirstCheckQuantities((current) => ({ ...current, [line.id]: value }))}
                      keyboardType="number-pad" />
                  </View>
                ))}
                {(['first', 'second'] as const).map((checkName) => {
                  const checkAdjustment = splitAdjustments[checkName];
                  const label = checkName === 'first' ? 'Check 1' : 'Check 2';
                  return <View key={checkName} style={styles.field}>
                    <Text style={styles.label}>{label} adjustment</Text>
                    <View style={styles.row}>
                      <ActionButton title="Percent" variant={checkAdjustment.discountType === 'PERCENTAGE' ? 'primary' : 'secondary'}
                        onPress={() => setSplitAdjustments((current) => ({
                          ...current, [checkName]: { ...current[checkName], discountType: 'PERCENTAGE' },
                        }))} disabled={busy} />
                      <ActionButton title="Fixed" variant={checkAdjustment.discountType === 'FIXED' ? 'primary' : 'secondary'}
                        onPress={() => setSplitAdjustments((current) => ({
                          ...current, [checkName]: { ...current[checkName], discountType: 'FIXED' },
                        }))} disabled={busy} />
                    </View>
                    <Input label={checkAdjustment.discountType === 'PERCENTAGE' ? `${label} discount percent` : `${label} discount (paise)`}
                      value={checkAdjustment.discountValue}
                      onChangeText={(value) => setSplitAdjustments((current) => ({
                        ...current, [checkName]: { ...current[checkName], discountValue: value },
                      }))}
                      keyboardType={checkAdjustment.discountType === 'PERCENTAGE' ? 'decimal-pad' : 'number-pad'} />
                    <Input label={`${label} tip (paise)`} value={checkAdjustment.tipAmount}
                      onChangeText={(value) => setSplitAdjustments((current) => ({
                        ...current, [checkName]: { ...current[checkName], tipAmount: value },
                      }))} keyboardType="number-pad" />
                  </View>;
                })}
                <View style={styles.row}>
                  <ActionButton title="Create split invoices" onPress={splitActiveBill} disabled={busy} />
                  <ActionButton title="Cancel split" variant="secondary" onPress={() => setSplitMode(false)} disabled={busy} />
                </View>
              </View>}
            </View>}

            {invoice && <View style={styles.card}>
              {invoiceChoices.length > 1 && <View style={styles.field}>
                <Text style={styles.label}>Split checks</Text>
                <View style={styles.row}>
                  {invoiceChoices.map((choice) => <ActionButton key={choice.id}
                    title={`${choice.invoiceNumber} · ${formatPaise(choice.totalAmount)}`}
                    variant={choice.id === invoice.id ? 'primary' : 'secondary'}
                    onPress={() => { setInvoice(choice); setPaymentAmount(choice.balanceAmount); }} disabled={busy} />)}
                </View>
              </View>}
              <Text style={styles.sectionTitle}>Invoice {invoice.invoiceNumber}</Text>
              <Text style={styles.hint}>Total {formatPaise(invoice.totalAmount)} · paid {formatPaise(invoice.paidAmount)} · due {formatPaise(invoice.balanceAmount)} · {invoice.paymentStatus}</Text>
              <Text style={styles.hint}>Taxable {formatPaise(invoice.taxableAmount)} · GST {formatPaise(invoice.totalTax)}</Text>
              {BigInt(invoice.discountAmount) > 0n && <Text style={styles.hint}>Discount {formatPaise(invoice.discountAmount)}</Text>}
              {BigInt(invoice.serviceChargeAmount) > 0n && <Text style={styles.hint}>
                Service charge {formatPaise(invoice.serviceChargeAmount)}{BigInt(invoice.serviceChargeTax) > 0n ? ` · GST ${formatPaise(invoice.serviceChargeTax)} (${invoice.serviceChargeTaxCode})` : ''}
              </Text>}
              {BigInt(invoice.tipAmount) > 0n && <Text style={styles.hint}>Non-taxable tip {formatPaise(invoice.tipAmount)}</Text>}
              <Text style={styles.hint}>Round off {formatSignedPaise(invoice.roundOffAmount)}</Text>
              {BigInt(invoice.balanceAmount) > 0n && <>
                {!shift && <View style={styles.field}>
                  <Text style={styles.hint}>Open a cashier shift before accepting cash payments.</Text>
                  <Input label="Opening cash (paise)" value={openingCash} onChangeText={setOpeningCash} keyboardType="number-pad" />
                  <ActionButton title="Open cashier shift" variant="secondary" onPress={beginShift} disabled={busy} />
                </View>}
                <View style={styles.row}>
                  {(['UPI', 'CARD', 'CASH', 'OTHER'] as const).map((method) => (
                    <ActionButton key={method} title={method} variant={paymentMethod === method ? 'primary' : 'secondary'} onPress={() => setPaymentMethod(method)} disabled={busy} />
                  ))}
                </View>
                <Input label="Payment amount (paise)" value={paymentAmount} onChangeText={setPaymentAmount} keyboardType="number-pad" />
                <View style={styles.row}>
                  <ActionButton title="Record payment" onPress={payInvoice} disabled={busy || (paymentMethod === 'CASH' && !shift)} />
                  <ActionButton title="Refresh invoice" variant="secondary" onPress={refreshInvoice} disabled={busy} />
                </View>
              </>}
            </View>}

            <View style={styles.card}>
              <View style={styles.row}>
                <View style={styles.flex}>
                  <Text style={styles.sectionTitle}>Device status</Text>
                  <Text style={styles.hint}>Device {config.deviceId.slice(0, 8)} · outlet {config.outletId.slice(0, 8)}</Text>
                </View>
                <ActionButton title="Sign out" variant="secondary" onPress={signOut} disabled={busy} />
              </View>
              <View style={styles.metrics}>
                <Metric label="Pending events" value={String(pendingCount)} />
                <Metric label="Rejected" value={String(rejectedCount)} />
                <Metric label="Master records" value={String(masterCount)} />
              </View>
              <ActionButton title={busy ? 'Syncing…' : 'Sync now'} onPress={syncNow} disabled={busy} />
              {lastSync && <Text style={styles.hint}>Cursor {lastSync.cursor}</Text>}
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Create a local order event</Text>
              <Text style={styles.hint}>This demo order is only local data until an operator reviews the uploaded event.</Text>
              <Input label="Item name" value={itemName} onChangeText={setItemName} />
              <Input label="Quantity" value={quantity} onChangeText={setQuantity} keyboardType="number-pad" />
              <ActionButton title="Save locally" onPress={addLocalOrder} disabled={busy || !itemName.trim()} />
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Recent local orders</Text>
              {orders.length ? orders.map((order) => (
                <View key={order.id} style={styles.listRow}>
                  <View style={styles.flex}>
                    <Text style={styles.listTitle}>{order.quantity} × {order.itemName}</Text>
                    <Text style={styles.hint}>{new Date(order.createdAt).toLocaleString()}</Text>
                  </View>
                  <Text style={styles.hint}>{order.id.slice(0, 8)}</Text>
                </View>
              )) : <Text style={styles.hint}>No local orders yet.</Text>}
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Outbox</Text>
              {outbox.length ? outbox.map((event) => (
                <View key={event.eventId} style={styles.listRow}>
                  <View style={styles.flex}>
                    <Text style={styles.listTitle}>#{event.deviceSeq} · {event.eventType}</Text>
                    {event.reason && <Text style={styles.error}>{event.reason}</Text>}
                  </View>
                  <Text style={event.status === 'REJECTED' ? styles.error : styles.hint}>{event.status}</Text>
                </View>
              )) : <Text style={styles.hint}>No events queued.</Text>}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Input({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput autoCorrect={false} style={styles.input} placeholder={label} {...props} />
    </View>
  );
}

function ActionButton({ title, onPress, disabled, variant = 'primary' }: {
  title: string; onPress: () => void; disabled?: boolean; variant?: 'primary' | 'secondary';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => { void onPress(); }}
      disabled={disabled}
      style={[styles.button, variant === 'secondary' && styles.buttonSecondary, disabled && styles.buttonDisabled]}
    >
      <Text style={[styles.buttonText, variant === 'secondary' && styles.buttonSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <View style={styles.metric}><Text style={styles.metricValue}>{value}</Text><Text style={styles.hint}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6f8' },
  content: { padding: 20, paddingBottom: 40, gap: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f4f6f8' },
  eyebrow: { color: '#52606d', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  title: { color: '#14212b', fontSize: 26, fontWeight: '700' },
  description: { color: '#52606d', fontSize: 14, lineHeight: 20, marginBottom: 4 },
  card: { backgroundColor: '#ffffff', borderColor: '#d9e0e5', borderWidth: 1, borderRadius: 12, padding: 16, gap: 12 },
  sectionTitle: { color: '#14212b', fontSize: 17, fontWeight: '700' },
  hint: { color: '#657580', fontSize: 12, lineHeight: 17 },
  label: { color: '#33434f', fontSize: 13, fontWeight: '600' },
  field: { gap: 5 },
  input: { minHeight: 44, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#c7d0d7', backgroundColor: '#ffffff', color: '#14212b' },
  button: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#116a5b' },
  buttonSecondary: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#c7d0d7' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#ffffff', fontWeight: '700' },
  buttonSecondaryText: { color: '#14212b' },
  error: { color: '#a12525', fontSize: 13 },
  notice: { color: '#166a43', fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  metrics: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  metric: { flex: 1, padding: 10, borderRadius: 8, backgroundColor: '#f4f6f8' },
  metricValue: { color: '#14212b', fontSize: 19, fontWeight: '700' },
  listRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#eef1f3' },
  listTitle: { color: '#14212b', fontWeight: '600' },
});
