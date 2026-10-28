import * as SecureStore from 'expo-secure-store';
import type { SyncPullResponse, SyncPushResponse, SyncEventInput } from '@rms/shared';

const ACCESS_TOKEN_KEY = 'rms_pos_access_token';
const REFRESH_TOKEN_KEY = 'rms_pos_refresh_token';
const CONFIG_KEY = 'rms_pos_config';

export type PosConfig = {
  apiUrl: string;
  tenantSlug: string;
  deviceId: string;
  outletId: string;
};
export type PosMenuItem = {
  id: string; categoryName: string; name: string; description: string | null;
  dietaryType: 'VEG' | 'NON_VEG' | 'EGG'; isAvailable: boolean;
};
export type PosVariant = { id: string; name: string; basePrice: string; isDefault: boolean };
export type PosAddOn = { id: string; name: string; price: string; isActive: boolean };
export type PosAddOnGroup = {
  id: string; name: string; minSelection: number; maxSelection: number;
  isMandatory: boolean; addOns: PosAddOn[];
};
export type PosTable = {
  id: string; code: string; name: string; capacity: number;
  state: 'AVAILABLE' | 'IN_USE' | 'RESERVED' | 'UNAVAILABLE'; mergedOrderId?: string | null;
};
export type PosOrderLine = { id: string; itemName: string; variantName: string; quantity: number };
export type PosWaiter = { id: string; name: string };
export type PosOrder = {
  id: string; status: string; orderType: string; tableId: string | null; billingGroupId: string | null;
  assignedWaiterId: string | null; items: PosOrderLine[];
  joinedTables: { id: string; code: string; name: string; capacity: number }[];
  kotTickets: { id: string; status: string }[];
};
export type PosOrderSummary = {
  id: string; status: string; orderType: string; tableId: string | null;
  billingGroupId: string | null; assignedWaiterId: string | null;
};
export type PosInvoice = {
  id: string; invoiceNumber: string; totalAmount: string; paidAmount: string; balanceAmount: string;
  paymentStatus: string; taxableAmount: string; totalTax: string; discountAmount: string;
  serviceChargeAmount: string; serviceChargeTax: string; serviceChargeTaxCode: string | null;
  tipAmount: string; roundOffAmount: string;
  lines: (PosOrderLine & { discountAmount: string; totalAmount: string })[];
};
export type PosPaymentMethod = 'CASH' | 'CARD' | 'UPI' | 'OTHER';
export type PosShift = { id: string; openingCash: string; openedAt: string };

type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };
type ApiEnvelope<T> = { success: true; data: T } | {
  success: false;
  error?: { code?: string; message?: string };
  requestId?: string;
};

function readEnvelope<T>(body: unknown, status: number): T {
  if (!body || typeof body !== 'object') throw new Error(`Server returned an invalid response (${status})`);
  const envelope = body as ApiEnvelope<T>;
  if (!envelope.success) {
    const message = envelope.error?.message ?? `Request failed (${status})`;
    const requestId = 'requestId' in envelope ? envelope.requestId : undefined;
    throw new Error(requestId ? `${message} (request ${requestId})` : message);
  }
  return envelope.data;
}

function validateTokenPair(value: unknown): TokenPair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The server returned an invalid session response');
  }
  const pair = value as Record<string, unknown>;
  if (typeof pair.accessToken !== 'string' || !pair.accessToken
    || typeof pair.refreshToken !== 'string' || !pair.refreshToken
    || typeof pair.expiresIn !== 'number' || !Number.isFinite(pair.expiresIn) || pair.expiresIn <= 0) {
    throw new Error('The server returned an invalid session response');
  }
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, expiresIn: pair.expiresIn };
}

function normalizeApiUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Enter an API origin only, such as https://api.example.com');
  }
  if (!__DEV__ && url.protocol !== 'https:') throw new Error('The production API must use HTTPS');
  return url.origin;
}

export async function loadSavedConfig(): Promise<PosConfig | null> {
  const value = await SecureStore.getItemAsync(CONFIG_KEY);
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (reason) {
    throw new Error('Saved POS setup is not valid JSON', { cause: reason });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Saved POS setup is invalid');
  }
  const config = parsed as Record<string, unknown>;
  if (typeof config.apiUrl !== 'string' || typeof config.tenantSlug !== 'string'
    || typeof config.deviceId !== 'string' || typeof config.outletId !== 'string') {
    throw new Error('Saved POS setup is missing required values');
  }
  return {
    apiUrl: config.apiUrl,
    tenantSlug: config.tenantSlug,
    deviceId: config.deviceId,
    outletId: config.outletId,
  };
}

export class PosApi {
  private constructor(private config: PosConfig) {}

  static async create(config: PosConfig) {
    const normalized = { ...config, apiUrl: normalizeApiUrl(config.apiUrl), tenantSlug: config.tenantSlug.trim() };
    if (!normalized.tenantSlug.trim()) throw new Error('Enter the restaurant tenant slug');
    await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(normalized));
    return new PosApi(normalized);
  }

  static async restore(config: PosConfig) {
    return new PosApi({ ...config, apiUrl: normalizeApiUrl(config.apiUrl) });
  }

  async login(email: string, password: string) {
    const pair = validateTokenPair(await this.publicPost<TokenPair>('/api/v1/auth/login', {
      tenantSlug: this.config.tenantSlug,
      email,
      password,
      deviceId: this.config.deviceId,
    }));
    await this.saveTokens(pair);
  }

  async me() {
    return this.authenticatedRequest<{ kind: string; userId: string; outletId: string | null }>('/api/v1/auth/me');
  }

  async menuItems() {
    return this.authenticatedRequest<PosMenuItem[]>('/api/v1/menu/items?page=1&limit=100');
  }

  async variants(menuItemId: string) {
    return this.authenticatedRequest<PosVariant[]>(`/api/v1/menu/items/${encodeURIComponent(menuItemId)}/variants`);
  }

  async addOnGroups(menuItemId: string) {
    return this.authenticatedRequest<PosAddOnGroup[]>(
      `/api/v1/menu/items/${encodeURIComponent(menuItemId)}/add-on-groups`,
    );
  }

  async variantPrice(variantId: string, channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY') {
    return this.authenticatedRequest<{ price: string; channel: string }>(
      `/api/v1/menu/variants/${encodeURIComponent(variantId)}/price?channel=${channel}`,
    );
  }

  async tables() {
    return this.authenticatedRequest<PosTable[]>('/api/v1/floor/tables');
  }

  async createOrder(input: {
    orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
    tableId?: string;
    items: { variantId: string; quantity: number; addOnIds?: string[] }[];
  }, idempotencyKey: string) {
    return this.authenticatedRequest<{ id: string; status: string; orderType: string; tableId: string | null }>('/api/v1/orders', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input),
    });
  }

  async sendKot(orderId: string, idempotencyKey: string) {
    return this.authenticatedRequest<{ id: string; status: string }>(`/api/v1/orders/${encodeURIComponent(orderId)}/kot`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({}),
    });
  }

  async holdOrder(orderId: string, idempotencyKey: string) {
    return this.authenticatedRequest<null>(`/api/v1/orders/${encodeURIComponent(orderId)}/hold`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({}),
    });
  }

  async resumeOrder(orderId: string, idempotencyKey: string) {
    return this.authenticatedRequest<null>(`/api/v1/orders/${encodeURIComponent(orderId)}/resume`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({}),
    });
  }

  async transferOrderTable(orderId: string, tableId: string, idempotencyKey: string) {
    return this.authenticatedRequest<null>(`/api/v1/orders/${encodeURIComponent(orderId)}/transfer-table`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ tableId }),
    });
  }

  async order(orderId: string) {
    return this.authenticatedRequest<PosOrder>(`/api/v1/orders/${encodeURIComponent(orderId)}`);
  }

  async orders() {
    return this.authenticatedRequest<PosOrderSummary[]>('/api/v1/orders?page=1&limit=100');
  }

  async waiters() {
    return this.authenticatedRequest<PosWaiter[]>('/api/v1/orders/waiters');
  }

  async assignWaiter(orderId: string, userId: string | null, idempotencyKey: string) {
    return this.authenticatedRequest<null>(`/api/v1/orders/${encodeURIComponent(orderId)}/waiter`, {
      method: 'PUT', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ userId }),
    });
  }

  async mergeTables(orderId: string, tableIds: string[], idempotencyKey: string) {
    return this.authenticatedRequest<{ orderId: string; joinedTableIds: string[] }>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/merge-tables`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ tableIds }) },
    );
  }

  async unmergeTables(orderId: string, tableIds: string[], idempotencyKey: string) {
    return this.authenticatedRequest<{ orderId: string; releasedTableIds: string[] }>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/unmerge-tables`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ tableIds }) },
    );
  }

  async mergeOrders(primaryOrderId: string, orderIds: string[], idempotencyKey: string) {
    return this.authenticatedRequest<{ billingGroupId: string; primaryOrderId: string; orderIds: string[] }>(
      `/api/v1/orders/${encodeURIComponent(primaryOrderId)}/merge`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ orderIds }) },
    );
  }

  async splitInvoices(
    orderId: string,
    checks: {
      items: { orderItemId: string; quantity: number }[];
      discount?: { type: 'PERCENTAGE' | 'FIXED'; value: string };
      tipAmount?: string;
    }[],
    idempotencyKey: string,
  ) {
    return this.authenticatedRequest<{ invoices: { id: string; invoiceNumber: string; totalAmount: string }[] }>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/invoices/split`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ checks }) },
    );
  }

  async finalizeInvoice(orderId: string, idempotencyKey: string, adjustment: {
    discount?: { type: 'PERCENTAGE' | 'FIXED'; value: string };
    tipAmount?: string;
  } = {}) {
    return this.authenticatedRequest<{ id: string; invoiceNumber: string; totalAmount: string }>(
      `/api/v1/orders/${encodeURIComponent(orderId)}/invoice`,
      { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(adjustment) },
    );
  }

  async invoice(invoiceId: string) {
    return this.authenticatedRequest<PosInvoice>(`/api/v1/invoices/${encodeURIComponent(invoiceId)}`);
  }

  async recordPayment(invoiceId: string, method: PosPaymentMethod, amount: string, idempotencyKey: string) {
    return this.authenticatedRequest<unknown>(`/api/v1/invoices/${encodeURIComponent(invoiceId)}/payments`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ method, amount }),
    });
  }

  async currentShift() {
    return this.authenticatedRequest<PosShift | null>('/api/v1/cashier-shifts/current');
  }

  async openShift(openingCash: string, idempotencyKey: string) {
    return this.authenticatedRequest<PosShift>('/api/v1/cashier-shifts', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ openingCash }),
    });
  }

  async hasSession() {
    return !!(await SecureStore.getItemAsync(ACCESS_TOKEN_KEY));
  }

  async push(events: SyncEventInput[]) {
    return this.authenticatedRequest<SyncPushResponse>('/api/v1/sync/push', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
  }

  async pull(since: string) {
    return this.authenticatedRequest<SyncPullResponse>(`/api/v1/sync/pull?since=${encodeURIComponent(since)}`);
  }

  async logout() {
    await this.authenticatedRequest<null>('/api/v1/auth/logout', { method: 'POST' });
    await this.clearTokens();
  }

  async clearTokens() {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    ]);
  }

  private async publicPost<T>(path: string, body: unknown) {
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    return readEnvelope<T>(payload, response.status);
  }

  private async authenticatedRequest<T>(path: string, init: RequestInit = {}) {
    const accessToken = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
    if (!accessToken) throw new Error('Sign in before syncing');
    let response = await this.send(path, init, accessToken);
    if (response.status === 401) {
      const refreshed = await this.refresh();
      response = await this.send(path, init, refreshed.accessToken);
    }
    const payload: unknown = await response.json().catch(() => null);
    return readEnvelope<T>(payload, response.status);
  }

  private async send(path: string, init: RequestInit, token: string) {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-outlet-id', this.config.outletId);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return fetch(`${this.config.apiUrl}${path}`, { ...init, headers });
  }

  private async refresh() {
    const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    if (!refreshToken) throw new Error('Session expired. Sign in again.');
    const response = await fetch(`${this.config.apiUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) await this.clearTokens();
      return readEnvelope<TokenPair>(payload, response.status);
    }
    const pair = validateTokenPair(readEnvelope<TokenPair>(payload, response.status));
    await this.saveTokens(pair);
    return pair;
  }

  private async saveTokens(pair: TokenPair) {
    try {
      await Promise.all([
        SecureStore.setItemAsync(ACCESS_TOKEN_KEY, pair.accessToken),
        SecureStore.setItemAsync(REFRESH_TOKEN_KEY, pair.refreshToken),
      ]);
    } catch (reason) {
      await this.clearTokens();
      throw reason;
    }
  }
}
