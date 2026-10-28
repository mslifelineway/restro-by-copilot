import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

export interface AuditEntry {
  tenantId?: string | null;
  actorId?: string | null;
  actorKind: 'tenant_user' | 'platform_user' | 'system';
  action: string;
  entity?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  /** Writes inside the caller's transaction so the audit row commits atomically with the change. */
  async log(c: PoolClient, e: AuditEntry): Promise<void> {
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, entity, entity_id, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.tenantId ?? null, e.actorId ?? null, e.actorKind, e.action, e.entity ?? null, e.entityId ?? null, JSON.stringify(e.meta ?? {})],
    );
  }
}
