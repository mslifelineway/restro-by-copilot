export interface SyncEventInput {
  deviceSeq: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface SyncPushResult {
  deviceSeq: string;
  eventId: string;
  status: 'RECEIVED' | 'DUPLICATE' | 'REJECTED';
  reason?: string;
  clockSkewWarning?: boolean;
}

export interface SyncPushResponse {
  serverTime: string;
  results: SyncPushResult[];
}

export interface SyncPullChange {
  sequence: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  recordedAt: string;
}

export interface SyncPullResponse {
  serverTime: string;
  cursor: string;
  hasMore: boolean;
  changes: SyncPullChange[];
}
