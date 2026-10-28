import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PoolClient } from 'pg';
import { config } from '../config';
import { verifySecret } from '../common/crypto';
import { ClientMeta } from '../common/decorators';
import { AppException } from '../common/errors';
import { JwtPayload } from '../common/request-context';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { IssuedSession, SessionService } from './session.service';

type Table = 'users' | 'platform_users';
interface Account { id: string; password_hash: string | null; pin_hash?: string | null; failed_attempts: number; locked_until: Date | null }

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }

@Injectable()
export class AuthService {
  constructor(private db: DbService, private jwt: JwtService, private audit: AuditService, private sessions: SessionService) {}

  private async pair(s: IssuedSession): Promise<TokenPair> {
    const payload: JwtPayload = { sub: s.owner.userId, kind: s.owner.kind, sid: s.sessionId, ...(s.owner.tenantId ? { tid: s.owner.tenantId } : {}) };
    return { accessToken: await this.jwt.signAsync(payload), refreshToken: s.refreshToken, expiresIn: config.jwtAccessTtlSeconds };
  }

  /**
   * Shared credential check with lockout. Generic 401 for every failure so callers cannot
   * enumerate tenants or emails. A locked account answers 429 without checking the secret.
   */
  private async check(c: PoolClient, table: Table, acct: Account | undefined, secret: string, field: 'password_hash' | 'pin_hash') {
    if (!acct) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
    if (acct.locked_until && acct.locked_until > new Date()) {
      throw new AppException(HttpStatus.TOO_MANY_REQUESTS, 'ACCOUNT_LOCKED', 'Account temporarily locked');
    }
    if (await verifySecret(secret, acct[field] ?? null)) {
      if (acct.failed_attempts) await c.query(`UPDATE ${table} SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [acct.id]);
      return;
    }
    const attempts = acct.failed_attempts + 1;
    const lock = attempts >= config.maxFailedAttempts;
    await c.query(
      `UPDATE ${table} SET failed_attempts = $2, locked_until = $3 WHERE id = $1`,
      [acct.id, lock ? 0 : attempts, lock ? new Date(Date.now() + config.lockMinutes * 60_000) : null],
    );
    throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
  }

  async tenantLogin(tenantSlug: string, email: string, secret: string, method: 'password' | 'pin', meta: ClientMeta, deviceId?: string) {
    // Failed-attempt counters must persist even though we then throw, so do the check in its own
    // transaction and rethrow after commit.
    let failure: unknown;
    const session = await this.db.tx({ platform: true }, async (c) => {
      const t = (await c.query(
        `SELECT id, status FROM tenants WHERE slug = $1 AND deleted_at IS NULL`, [tenantSlug])).rows[0];
      const u = t && (await c.query(
        `SELECT id, password_hash, pin_hash, failed_attempts, locked_until, status FROM users
          WHERE tenant_id = $1 AND lower(email) = lower($2) AND deleted_at IS NULL`, [t.id, email])).rows[0];
      try {
        if (t?.status === 'suspended' || t?.status === 'deleted' || u?.status === 'disabled') {
          throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
        }
        await this.check(c, 'users', u, secret, method === 'pin' ? 'pin_hash' : 'password_hash');
      } catch (e) { failure = e; return null; }

      if (deviceId) {
        const d = (await c.query(`SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`, [deviceId, t.id])).rowCount;
        if (!d) { failure = new AppException(HttpStatus.FORBIDDEN, 'DEVICE_NOT_REGISTERED', 'Device is not registered or has been revoked'); return null; }
        await c.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [deviceId]);
      }
      const s = await this.sessions.issue(c, { kind: 'tenant', tenantId: t.id, userId: u.id, deviceId }, meta);
      await this.audit.log(c, { tenantId: t.id, actorId: u.id, actorKind: 'tenant_user', action: `auth.login.${method}`, meta: { deviceId: deviceId ?? null } });
      return s;
    });
    if (failure || !session) throw failure;
    return this.pair(session);
  }

  async platformLogin(email: string, password: string, meta: ClientMeta) {
    let failure: unknown;
    const session = await this.db.tx({ platform: true }, async (c) => {
      const u = (await c.query(
        `SELECT id, password_hash, failed_attempts, locked_until FROM platform_users WHERE lower(email) = lower($1)`, [email])).rows[0];
      try { await this.check(c, 'platform_users', u, password, 'password_hash'); } catch (e) { failure = e; return null; }
      const s = await this.sessions.issue(c, { kind: 'platform', tenantId: null, userId: u.id }, meta);
      await this.audit.log(c, { actorId: u.id, actorKind: 'platform_user', action: 'auth.login.platform' });
      return s;
    });
    if (failure || !session) throw failure;
    return this.pair(session);
  }

  async refresh(refreshToken: string, meta: ClientMeta) {
    return this.pair(await this.sessions.rotate(refreshToken, meta));
  }

  async logout(sessionId: string) {
    await this.db.tx({ platform: true }, (c) => this.sessions.revoke(c, { sessionId }, 'logout'));
  }

  async logoutAll(kind: 'tenant' | 'platform', userId: string) {
    return this.db.tx({ platform: true }, (c) => this.sessions.revoke(c, { kind, userId }, 'logout_all'));
  }
}
