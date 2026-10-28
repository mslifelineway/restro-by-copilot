import type { SyncEventInput, SyncPullResponse, SyncPushResponse, SyncPushResult } from '@rms/shared';
import { applyPullChanges, currentCursor, pendingEvents, recordPushResults } from './database';

export type SyncTransport = {
  push(events: SyncEventInput[]): Promise<SyncPushResponse>;
  pull(since: string): Promise<SyncPullResponse>;
};

export type SyncSummary = {
  received: number;
  duplicates: number;
  rejected: number;
  changes: number;
  cursor: string;
};

export async function synchronize(api: SyncTransport, deviceId: string, outletId: string): Promise<SyncSummary> {
  let pushResults: SyncPushResult[] = [];
  for (;;) {
    const events = await pendingEvents(deviceId, outletId);
    if (!events.length) break;
    const response = await api.push(events);
    await recordPushResults(deviceId, outletId, events, response.results, response.serverTime);
    pushResults.push(...response.results);
  }

  let changes = 0;
  let cursor = await currentCursor(deviceId, outletId);
  for (;;) {
    const page = await api.pull(cursor);
    await applyPullChanges(deviceId, outletId, page.changes, page.cursor, page.serverTime);
    changes += page.changes.length;
    if (!page.hasMore) {
      cursor = page.cursor;
      break;
    }
    if (page.cursor === cursor) throw new Error('The sync server returned more changes without advancing the cursor');
    cursor = page.cursor;
  }

  return {
    received: pushResults.filter((result) => result.status === 'RECEIVED').length,
    duplicates: pushResults.filter((result) => result.status === 'DUPLICATE').length,
    rejected: pushResults.filter((result) => result.status === 'REJECTED').length,
    changes,
    cursor,
  };
}
