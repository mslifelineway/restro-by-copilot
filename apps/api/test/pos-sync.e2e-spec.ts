import type { SyncEventInput, SyncPullChange, SyncPushResult } from '@rms/shared';
import { synchronize, type SyncTransport } from '../../pos/src/sync/engine';
import { applyPullChanges, currentCursor, pendingEvents, recordPushResults } from '../../pos/src/sync/database';

jest.mock('../../pos/src/sync/database', () => ({
  applyPullChanges: jest.fn(),
  currentCursor: jest.fn(),
  pendingEvents: jest.fn(),
  recordPushResults: jest.fn(),
}));

describe('POS sync orchestration', () => {
  const deviceId = 'c0d0f0b0-1111-4111-8111-111111111111';
  const outletId = 'c0d0f0b0-2222-4222-8222-222222222222';
  let queued: SyncEventInput[];

  beforeEach(() => {
    jest.clearAllMocks();
    queued = Array.from({ length: 101 }, (_, index) => ({
      deviceSeq: String(index + 1),
      eventId: `c0d0f0b0-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      eventType: 'POS_ORDER_CREATED',
      occurredAt: '2026-01-01T00:00:00.000Z',
      payload: { orderId: `order-${index + 1}` },
    }));
    jest.mocked(pendingEvents).mockImplementation(async () => queued.slice(0, 100));
    jest.mocked(recordPushResults).mockImplementation(async (_device, _outlet, events) => {
      queued = queued.slice(events.length);
    });
    jest.mocked(currentCursor).mockResolvedValue('0');
    jest.mocked(applyPullChanges).mockResolvedValue(undefined);
  });

  it('pushes all batches, preserves server dispositions, and applies every pull page', async () => {
    const changes: SyncPullChange[] = [
      { sequence: '10', entityType: 'menu_item', entityId: 'item-1', payload: { id: 'item-1' }, recordedAt: '2026-01-01T00:00:00.000Z' },
      { sequence: '20', entityType: 'tax', entityId: 'tax-1', payload: { id: 'tax-1' }, recordedAt: '2026-01-01T00:00:01.000Z' },
    ];
    const transport: SyncTransport = {
      push: jest.fn(async (events) => ({
        serverTime: '2026-01-01T00:00:02.000Z',
        results: events.map((event): SyncPushResult => ({
          deviceSeq: event.deviceSeq,
          eventId: event.eventId,
          status: event.deviceSeq === '98' || event.deviceSeq === '101'
            ? 'REJECTED'
            : Number(event.deviceSeq) % 2 === 0 ? 'DUPLICATE' : 'RECEIVED',
          ...(event.deviceSeq === '98' || event.deviceSeq === '101' ? { reason: 'INVALID_EVENT' } : {}),
        })),
      })),
      pull: jest.fn()
        .mockResolvedValueOnce({
          serverTime: '2026-01-01T00:00:03.000Z',
          cursor: '10',
          hasMore: true,
          changes: [changes[0]],
        })
        .mockResolvedValueOnce({
          serverTime: '2026-01-01T00:00:04.000Z',
          cursor: '20',
          hasMore: false,
          changes: [changes[1]],
        }),
    };

    const summary = await synchronize(transport, deviceId, outletId);

    expect(transport.push).toHaveBeenCalledTimes(2);
    expect(transport.push).toHaveBeenNthCalledWith(1, expect.arrayContaining([expect.objectContaining({ deviceSeq: '1' })]));
    expect(jest.mocked(recordPushResults)).toHaveBeenCalledTimes(2);
    expect(transport.pull).toHaveBeenNthCalledWith(1, '0');
    expect(transport.pull).toHaveBeenNthCalledWith(2, '10');
    expect(jest.mocked(applyPullChanges)).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ received: 50, duplicates: 49, rejected: 2, changes: 2, cursor: '20' });
  });
});
