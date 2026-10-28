import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PoolClient } from 'pg';
import { config } from '../config';
import { ClientMeta } from '../common/decorators';
import { AppException } from '../common/errors';
import { TtlCache } from '../common/ttl-cache';
import { DbService } from '../db/db.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SessionOwner { kind: 'tenant' | 'platform'; tenantId: string | null; userId: string; deviceId?: string | null }
export interface IssuedSession { sessionId: string; refreshToken: string; owner: SessionOwner }

/**
 * Refresh-token sessions. Token = `<sessionId>.<secret>`; only sha256(secret) is stored.
 * Every refresh rotates the token. Presenting an already-rotated token means it leaked, so the
 * whole family (rotation chain) is revoked. Revocation takes effect on access tokens within ~5 s
 * because AuthGuard checks `isActive(sid)` through a short cache.
 */
@Injectable()
export class SessionService {
  private active = new TtlCache<boolean>(5_000);
  constructor(private db: DbService) {}

  async issue(c: PoolClient, owner: SessionOwner, meta: ClientMeta, familyId?: string): Promise<IssuedSession> {
    const secret = randomBytes(32).toString('base64url');
    const row = (await c.query(
      `INSERT INTO sessions (family_id, kind, tenant_id, user_id, device_id, refresh_hash, expires_at, user_agent, ip)
       VALUES (COALESCE($1, gen_random_uuid()),$2,$3,$4,$5,$6, now() + make_interval(days => $7),$8,$9) RETURNING id`,
      [familyId ?? null, owner.kind, owner.tenantId, owner.userId, owner.deviceId ?? null, sha256(secret), config.refreshTtlDays, meta.userAgent, meta.ip],
    )).rows[0];
    return { sessionId: row.id, refreshToken: `${row.id}.${secret}`, owner };
  }

  /** Validates and rotates a refresh token. Returns the new session (caller signs the access token). */
  async rotate(refreshToken: string, meta: ClientMeta): Promise<IssuedSession> {
    const [id, secret] = refreshToken.split('.');
    const invalid = () => new AppException(HttpStatus.UNAUTHORIZED, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
    if (!id || !secret || !/^[0-9a-f-]{36}$/i.test(id)) throw invalid();

    let failure: unknown;
    const out = await this.db.tx({ platform: true }, async (c) => {
      const s = (await c.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const a = Buffer.from(s?.refresh_hash ?? '', 'hex'), b = Buffer.from(sha256(secret), 'hex');
      if (!s || a.length !== b.length || !timingSafeEqual(a, b)) { failure = invalid(); return null; }

      if (s.revoked_at) {
        const recentlyRotated = s.revoked_reason === 'rotated' && Date.now() - new Date(s.revoked_at).getTime() < config.refreshReuseLeewaySeconds * 1000;
        if (recentlyRotated) {
          // Benign race (parallel requests, client retry): hand out another token in the same chain.
          const again = await this.issue(c, { kind: s.kind, tenantId: s.tenant_id, userId: s.user_id, deviceId: s.device_id }, meta, s.family_id);
          await c.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [id]);
          return again;
        }
        if (s.replaced_by) { // reuse of a rotated token outside the leeway => assume theft, kill the whole chain
          await this.revokeFamilyOf(c, id, 'reuse_detected');
          failure = new AppException(HttpStatus.UNAUTHORIZED, 'REFRESH_TOKEN_REUSED', 'Refresh token was already used; session revoked');
        } else failure = invalid();
        return null;
      }
      if (s.expires_at < new Date()) { failure = invalid(); return null; }

      // The account must still be allowed to sign in.
      const ok = s.kind === 'platform'
        ? (await c.query('SELECT 1 FROM platform_users WHERE id = $1', [s.user_id])).rowCount
        : (await c.query(
            `SELECT 1 FROM users u JOIN tenants t ON t.id = u.tenant_id
              WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND t.status IN ('trial','active') AND t.deleted_at IS NULL
                AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id = $2 AND d.status = 'active' AND d.deleted_at IS NULL))`,
            [s.user_id, s.device_id])).rowCount;
      if (!ok) {
        await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'account_inactive' WHERE id = $1`, [id]);
        failure = invalid();
        return null;
      }

      const next = await this.issue(c, { kind: s.kind, tenantId: s.tenant_id, userId: s.user_id, deviceId: s.device_id }, meta, s.family_id);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = $2, last_used_at = now() WHERE id = $1`, [id, next.sessionId]);
      return next;
    });
    this.active.clear();
    if (failure || !out) throw failure;
    return out;
  }

  /** Ends every session in the same rotation chain (all tokens ever issued from one login). */
  private revokeFamilyOf(c: PoolClient, sessionId: string, reason: string) {
    return c.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = (SELECT family_id FROM sessions WHERE id = $1)
          AND (revoked_at IS NULL OR revoked_reason = 'rotated')`,
      [sessionId, reason]);
  }

  /**
   * Cached check used on every authenticated request. A session that was merely ROTATED stays valid for
   * its (short-lived) access token; ended sessions (logout, reuse, force logout, ...) do not.
   */
  async isActive(sid: string): Promise<boolean> {
    const hit = this.active.get(sid);
    if (hit !== undefined) return hit;
    const ok = await this.db.tx({ platform: true }, async (c) =>
      !!(await c.query(`SELECT 1 FROM sessions WHERE id = $1 AND (revoked_at IS NULL OR revoked_reason = 'rotated') AND expires_at > now()`, [sid])).rowCount);
    this.active.set(sid, ok);
    return ok;
  }

  /** Ends sessions matching the filter. A sessionId revokes its whole rotation chain. Returns how many live chains' tokens were ended. */
  async revoke(c: PoolClient, where: { sessionId?: string; kind?: 'tenant' | 'platform'; userId?: string; deviceId?: string; exceptSessionId?: string }, reason: string) {
    const r = await c.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $5
        WHERE (revoked_at IS NULL OR revoked_reason = 'rotated')
          AND ($1::uuid IS NULL OR family_id = (SELECT family_id FROM sessions WHERE id = $1))
          AND ($2::text IS NULL OR kind = $2) AND ($3::uuid IS NULL OR user_id = $3) AND ($4::uuid IS NULL OR device_id = $4)
          AND ($6::uuid IS NULL OR family_id <> (SELECT family_id FROM sessions WHERE id = $6))
        RETURNING id, replaced_by`,
      [where.sessionId ?? null, where.kind ?? null, where.userId ?? null, where.deviceId ?? null, reason, where.exceptSessionId ?? null]);
    this.active.clear();
    // count login chains, not rotated rows: the head of a chain is the row nothing replaced
    return r.rows.filter((x) => !x.replaced_by).length;
  }
}
