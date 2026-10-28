import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { config } from '../config';
import { hashSecret, verifySecret } from '../common/crypto';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';
import { MailService } from '../mail/mail.service';
import { SessionService } from './session.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const invalidToken = () => new AppException(HttpStatus.BAD_REQUEST, 'RESET_TOKEN_INVALID', 'This reset link is invalid or has expired. Request a new one.');

type Account = { id: string; kind: 'tenant' | 'platform'; tenantId: string | null; email: string; name: string };

@Injectable()
export class PasswordService {
  private log = new Logger('Password');
  constructor(private db: DbService, private audit: AuditService, private sessions: SessionService, private mail: MailService) {}

  // ---------- signed-in: change password ----------
  /**
   * Requires the current password (a stolen session alone cannot take over the account) and shares the login
   * lockout counter. Ends every OTHER session so a leaked token dies with the old password.
   * Wrong current password is 400 (not 401): a 401 would make clients think their session expired.
   */
  async change(ctx: RequestCtx, current: string, next: string) {
    const table = ctx.kind === 'platform' ? 'platform_users' : 'users';
    let failure: unknown;
    const out = await this.db.tx(ctx.kind === 'platform' ? { platform: true } : { tenantId: ctx.tenantId! }, async (c) => {
      const a = (await c.query(`SELECT id, password_hash, failed_attempts, locked_until FROM ${table} WHERE id = $1`, [ctx.userId])).rows[0];
      if (a.locked_until && a.locked_until > new Date()) { failure = new AppException(HttpStatus.TOO_MANY_REQUESTS, 'ACCOUNT_LOCKED', 'Account temporarily locked'); return null; }
      if (!(await verifySecret(current, a.password_hash))) {
        const attempts = a.failed_attempts + 1;
        const lock = attempts >= config.maxFailedAttempts;
        await c.query(`UPDATE ${table} SET failed_attempts = $2, locked_until = $3 WHERE id = $1`, [a.id, lock ? 0 : attempts, lock ? new Date(Date.now() + config.lockMinutes * 60_000) : null]);
        failure = new AppException(HttpStatus.BAD_REQUEST, 'CURRENT_PASSWORD_INCORRECT', 'Current password is incorrect');
        return null; // commit the counter, then throw
      }
      if (await verifySecret(next, a.password_hash)) { failure = new AppException(HttpStatus.BAD_REQUEST, 'PASSWORD_UNCHANGED', 'New password must be different from the current one'); return null; }
      await c.query(`UPDATE ${table} SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1`, [a.id, await hashSecret(next)]);
      const ended = await this.sessions.revoke(c, { kind: ctx.kind, userId: ctx.userId, exceptSessionId: ctx.sessionId }, 'password_changed');
      await this.audit.log(c, { tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: ctx.kind === 'platform' ? 'platform_user' : 'tenant_user', action: 'auth.password_change', entity: 'user', entityId: ctx.userId, meta: { sessionsEnded: ended } });
      return { sessionsEnded: ended };
    });
    if (failure || !out) throw failure;
    return out;
  }

  // ---------- forgot password ----------
  /**
   * Always succeeds from the caller's point of view (no account enumeration). An email is sent only for an active
   * account in an active tenant, at most `resetMaxPerHour` per account per hour. A new request invalidates earlier links.
   */
  async requestReset(tenantSlug: string | undefined, email: string, ip: string | null) {
    let toSend: { account: Account; link: string } | null = null;
    await this.db.tx({ platform: true }, async (c) => {
      let acct: Account | undefined;
      if (tenantSlug) {
        const r = (await c.query(
          `SELECT u.id, u.tenant_id AS "tenantId", u.email, u.name FROM users u JOIN tenants t ON t.id = u.tenant_id
            WHERE t.slug = $1 AND t.status IN ('trial','active') AND t.deleted_at IS NULL
              AND lower(u.email) = lower($2) AND u.status = 'active' AND u.deleted_at IS NULL`, [tenantSlug, email])).rows[0];
        if (r) acct = { ...r, kind: 'tenant' };
      } else {
        const r = (await c.query('SELECT id, email, name FROM platform_users WHERE lower(email) = lower($1)', [email])).rows[0];
        if (r) acct = { ...r, kind: 'platform', tenantId: null };
      }
      if (!acct) return;

      const recent = (await c.query(`SELECT count(*)::int AS n FROM password_resets WHERE kind = $1 AND user_id = $2 AND created_at > now() - interval '1 hour'`, [acct.kind, acct.id])).rows[0].n;
      if (recent >= config.resetMaxPerHour) return;

      await c.query(`UPDATE password_resets SET used_at = now() WHERE kind = $1 AND user_id = $2 AND used_at IS NULL`, [acct.kind, acct.id]);
      const secret = randomBytes(32).toString('base64url');
      const row = (await c.query(
        `INSERT INTO password_resets (kind, tenant_id, user_id, token_hash, expires_at, ip) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5), $6) RETURNING id`,
        [acct.kind, acct.tenantId, acct.id, sha256(secret), config.resetTtlMinutes, ip])).rows[0];
      await this.audit.log(c, { tenantId: acct.tenantId, actorId: acct.id, actorKind: acct.kind === 'platform' ? 'platform_user' : 'tenant_user', action: 'auth.password_reset_requested' });
      toSend = { account: acct, link: `${config.adminUrl}/reset-password?token=${row.id}.${secret}` };
    });

    if (toSend) {
      const { account, link } = toSend as { account: Account; link: string };
      // fire-and-forget: delivery latency/failure must not reveal whether the account exists
      void this.mail.send({
        to: account.email,
        subject: 'Reset your RMS password',
        text: `Hi ${account.name},\n\nUse this link to choose a new password (valid for ${config.resetTtlMinutes} minutes, one use):\n${link}\n\nIf you did not ask for this, ignore this email - your password has not changed.`,
        html: `<p>Hi ${escapeHtml(account.name)},</p><p><a href="${link}">Choose a new password</a> (valid for ${config.resetTtlMinutes} minutes, one use).</p><p>If you did not ask for this, ignore this email - your password has not changed.</p>`,
      }).catch((e) => this.log.error(`reset email failed: ${(e as Error).message}`));
    }
  }

  // ---------- reset with token ----------
  async reset(token: string, next: string) {
    const [id, secret] = token.split('.');
    if (!id || !secret || !/^[0-9a-f-]{36}$/i.test(id)) throw invalidToken();

    let failure: unknown;
    await this.db.tx({ platform: true }, async (c) => {
      const r = (await c.query('SELECT * FROM password_resets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const a = Buffer.from(r?.token_hash ?? '', 'hex'), b = Buffer.from(sha256(secret), 'hex');
      if (!r || a.length !== b.length || !timingSafeEqual(a, b) || r.used_at || r.expires_at < new Date()) { failure = invalidToken(); return; }

      const table = r.kind === 'platform' ? 'platform_users' : 'users';
      const active = r.kind === 'platform'
        ? (await c.query('SELECT 1 FROM platform_users WHERE id = $1', [r.user_id])).rowCount
        : (await c.query(`SELECT 1 FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND t.status IN ('trial','active') AND t.deleted_at IS NULL`, [r.user_id])).rowCount;
      if (!active) { failure = invalidToken(); return; }

      // clears any lockout too: resetting is the legitimate way out of a locked account
      await c.query(`UPDATE ${table} SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1`, [r.user_id, await hashSecret(next)]);
      await c.query(`UPDATE password_resets SET used_at = now() WHERE kind = $1 AND user_id = $2 AND used_at IS NULL`, [r.kind, r.user_id]);
      const ended = await this.sessions.revoke(c, { kind: r.kind, userId: r.user_id }, 'password_reset');
      await this.audit.log(c, { tenantId: r.tenant_id, actorId: r.user_id, actorKind: r.kind === 'platform' ? 'platform_user' : 'tenant_user', action: 'auth.password_reset', entity: 'user', entityId: r.user_id, meta: { sessionsEnded: ended } });
    });
    if (failure) throw failure;
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
