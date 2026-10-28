import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashSecret } from '../src/common/crypto';
import { config } from '../src/config';
import { runMigrations } from '../src/db/migrate';
import { runSeed } from '../src/db/seed';
import { MailService } from '../src/mail/mail.service';

const run = `${Date.now().toString(36)}p`;
const OLD = 'old-password-123';
const NEW = 'brand-new-password-456';

describe('change password & forgot/reset password', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let mail: MailService;
  let adminToken: string;
  let owner: Client;
  const tenant = { id: '', slug: `pw-${run}`, ownerEmail: '' };

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = (email: string, password: string) => http.post('/api/v1/auth/login').send({ tenantSlug: tenant.slug, email, password });
  const tokenFromMail = (to: string): string => {
    const m = [...mail.outbox].reverse().find((x) => x.to === to);
    return /token=([\w.-]+)/.exec(m?.text ?? '')?.[1] ?? '';
  };
  const mailCount = (to: string) => mail.outbox.filter((m) => m.to === to).length;
  const forgot = (email: string, slug: string | null = tenant.slug) => http.post('/api/v1/auth/forgot-password').send({ ...(slug ? { tenantSlug: slug } : {}), email });
  const newUser = async (email: string, password = OLD) => {
    const roles = (await http.get('/api/v1/roles').set(bearer(ownerToken))).body.data as { id: string; name: string }[];
    const r = await http.post('/api/v1/users').set(bearer(ownerToken)).send({ email, name: 'Staff', password, assignments: [{ roleId: roles.find((x) => x.name === 'Cashier')!.id }] });
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  };
  let ownerToken: string;

  beforeAll(async () => {
    await runMigrations();
    await runSeed();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
    mail = app.get(MailService);
    owner = new Client({ connectionString: config.databaseOwnerUrl });
    await owner.connect();

    adminToken = (await http.post('/api/v1/auth/platform/login').send({ email: config.platformAdminEmail, password: config.platformAdminPassword })).body.data.accessToken;
    tenant.ownerEmail = `owner@${tenant.slug}.test`;
    const c = await http.post('/api/v1/platform/tenants').set(bearer(adminToken))
      .send({ name: 'PW', slug: tenant.slug, planCode: 'growth', ownerName: 'Owner', ownerEmail: tenant.ownerEmail, ownerPassword: OLD });
    expect(c.status).toBe(201);
    tenant.id = c.body.data.id;
    ownerToken = (await login(tenant.ownerEmail, OLD)).body.data.accessToken;
  });
  afterAll(async () => { await owner.end(); await app.close(); });

  describe('change password (signed in)', () => {
    it('requires the correct current password and answers 400, not 401', async () => {
      const email = `chg1@${tenant.slug}.test`;
      await newUser(email);
      const tok = (await login(email, OLD)).body.data.accessToken;
      const r = await http.post('/api/v1/auth/change-password').set(bearer(tok)).send({ currentPassword: 'nope-nope-nope', newPassword: NEW });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('CURRENT_PASSWORD_INCORRECT');
      expect((await http.get('/api/v1/auth/me').set(bearer(tok))).status).toBe(200); // session untouched
    });

    it('changes the password, keeps this session, ends the others, and the old password stops working', async () => {
      const email = `chg2@${tenant.slug}.test`;
      await newUser(email);
      const here = (await login(email, OLD)).body.data;
      const elsewhere = (await login(email, OLD)).body.data;

      const r = await http.post('/api/v1/auth/change-password').set(bearer(here.accessToken)).send({ currentPassword: OLD, newPassword: NEW });
      expect(r.status).toBe(200);
      expect(r.body.data.sessionsEnded).toBe(1);
      expect((await http.get('/api/v1/auth/me').set(bearer(here.accessToken))).status).toBe(200);
      expect((await http.get('/api/v1/auth/me').set(bearer(elsewhere.accessToken))).body.error.code).toBe('SESSION_REVOKED');
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: elsewhere.refreshToken })).status).toBe(401);
      expect((await login(email, OLD)).status).toBe(401);
      expect((await login(email, NEW)).status).toBe(200);
      const audit = (await http.get('/api/v1/audit-log?limit=50').set(bearer(ownerToken))).body.data as { action: string }[];
      expect(audit.some((a) => a.action === 'auth.password_change')).toBe(true);
    });

    it('validates the new password and rejects reusing the current one', async () => {
      const email = `chg3@${tenant.slug}.test`;
      await newUser(email);
      const tok = (await login(email, OLD)).body.data.accessToken;
      const short = await http.post('/api/v1/auth/change-password').set(bearer(tok)).send({ currentPassword: OLD, newPassword: 'short' });
      expect(short.body.error.code).toBe('VALIDATION_FAILED');
      expect(short.body.error.details[0].field).toBe('newPassword');
      const same = await http.post('/api/v1/auth/change-password').set(bearer(tok)).send({ currentPassword: OLD, newPassword: OLD });
      expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');
    });

    it('shares the lockout counter: repeated wrong current passwords lock the account', async () => {
      const email = `chg4@${tenant.slug}.test`;
      await newUser(email);
      const tok = (await login(email, OLD)).body.data.accessToken;
      for (let i = 0; i < 5; i++) await http.post('/api/v1/auth/change-password').set(bearer(tok)).send({ currentPassword: 'wrong-wrong-1', newPassword: NEW });
      const r = await http.post('/api/v1/auth/change-password').set(bearer(tok)).send({ currentPassword: OLD, newPassword: NEW });
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('requires authentication', async () => {
      expect((await http.post('/api/v1/auth/change-password').send({ currentPassword: OLD, newPassword: NEW })).status).toBe(401);
    });

    it('works for platform users', async () => {
      const email = `plat-${run}@rms.test`;
      await owner.query(`INSERT INTO platform_users (email, name, role, password_hash) VALUES ($1,'Temp Support','support',$2)`, [email, await hashSecret(OLD)]);
      const tok = (await http.post('/api/v1/auth/platform/login').send({ email, password: OLD })).body.data.accessToken;
      expect((await http.post('/api/v1/auth/change-password').set(bearer(tok)).send({ currentPassword: OLD, newPassword: NEW })).status).toBe(200);
      expect((await http.post('/api/v1/auth/platform/login').send({ email, password: OLD })).status).toBe(401);
      expect((await http.post('/api/v1/auth/platform/login').send({ email, password: NEW })).status).toBe(200);
    });
  });

  describe('forgot + reset password', () => {
    it('answers identically for existing and unknown accounts, and only emails the real one', async () => {
      const email = `fp1@${tenant.slug}.test`;
      await newUser(email);
      const known = await forgot(email);
      const unknown = await forgot(`ghost@${tenant.slug}.test`);
      const wrongTenant = await forgot(email, 'no-such-tenant');
      for (const r of [known, unknown, wrongTenant]) {
        expect(r.status).toBe(200);
        expect(r.body.message).toBe('If an account exists for that email, a reset link has been sent.');
        expect(r.body.data).toBeNull();
      }
      expect(mailCount(email)).toBe(1);
      expect(mailCount(`ghost@${tenant.slug}.test`)).toBe(0);
      expect(mail.outbox.find((m) => m.to === email)!.text).toContain(`${config.adminUrl}/reset-password?token=`);
    });

    it('resets with the emailed token, ends all sessions, clears lockout, and the token is single use', async () => {
      const email = `fp2@${tenant.slug}.test`;
      await newUser(email);
      const live = (await login(email, OLD)).body.data;
      for (let i = 0; i < 5; i++) await login(email, 'bad-password-xx'); // lock it
      expect((await login(email, OLD)).status).toBe(429);

      await forgot(email);
      const token = tokenFromMail(email);
      expect(token).not.toBe('');
      const r = await http.post('/api/v1/auth/reset-password').send({ token, newPassword: NEW });
      expect(r.status).toBe(200);
      expect(r.body.message).toBe('Password updated. You can now sign in.');

      expect((await http.get('/api/v1/auth/me').set(bearer(live.accessToken))).body.error.code).toBe('SESSION_REVOKED');
      expect((await login(email, OLD)).status).toBe(401);
      expect((await login(email, NEW)).status).toBe(200); // lockout cleared

      const again = await http.post('/api/v1/auth/reset-password').send({ token, newPassword: 'another-password-789' });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('RESET_TOKEN_INVALID');
    });

    it('rejects tampered, expired and garbage tokens with the same error', async () => {
      const email = `fp3@${tenant.slug}.test`;
      await newUser(email);
      await forgot(email);
      const token = tokenFromMail(email);
      const codes = async (t: string) => (await http.post('/api/v1/auth/reset-password').send({ token: t, newPassword: NEW })).body.error.code;
      expect(await codes(token.slice(0, -3) + 'xxx')).toBe('RESET_TOKEN_INVALID');
      expect(await codes('a'.repeat(40))).toBe('RESET_TOKEN_INVALID');
      await owner.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE id = $1`, [token.split('.')[0]]);
      expect(await codes(token)).toBe('RESET_TOKEN_INVALID');
    });

    it('a newer request invalidates the older link', async () => {
      const email = `fp4@${tenant.slug}.test`;
      await newUser(email);
      await forgot(email);
      const first = tokenFromMail(email);
      await forgot(email);
      const second = tokenFromMail(email);
      expect(second).not.toBe(first);
      expect((await http.post('/api/v1/auth/reset-password').send({ token: first, newPassword: NEW })).status).toBe(400);
      expect((await http.post('/api/v1/auth/reset-password').send({ token: second, newPassword: NEW })).status).toBe(200);
    });

    it('limits reset emails per account per hour without revealing it', async () => {
      const email = `fp5@${tenant.slug}.test`;
      await newUser(email);
      for (let i = 0; i < 5; i++) expect((await forgot(email)).status).toBe(200);
      expect(mailCount(email)).toBe(config.resetMaxPerHour);
    });

    it('sends nothing for disabled users or suspended tenants, and refuses reset after disable', async () => {
      const email = `fp6@${tenant.slug}.test`;
      const uid = await newUser(email);
      await forgot(email);
      const token = tokenFromMail(email);
      await http.patch(`/api/v1/users/${uid}`).set(bearer(ownerToken)).send({ status: 'disabled' });
      expect((await http.post('/api/v1/auth/reset-password').send({ token, newPassword: NEW })).body.error.code).toBe('RESET_TOKEN_INVALID');
      await forgot(email);
      expect(mailCount(email)).toBe(1);

      const email2 = `fp7@${tenant.slug}.test`;
      await newUser(email2);
      await http.patch(`/api/v1/platform/tenants/${tenant.id}/status`).set(bearer(adminToken)).send({ status: 'suspended' });
      await forgot(email2);
      expect(mailCount(email2)).toBe(0);
      await http.patch(`/api/v1/platform/tenants/${tenant.id}/status`).set(bearer(adminToken)).send({ status: 'active' });
    });

    it('validates input and works for platform users (no tenant slug)', async () => {
      expect((await http.post('/api/v1/auth/forgot-password').send({ email: 'not-an-email' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await http.post('/api/v1/auth/reset-password').send({ token: 'a'.repeat(40), newPassword: 'short' })).body.error.details[0].field).toBe('newPassword');

      const email = `plat2-${run}@rms.test`;
      await owner.query(`INSERT INTO platform_users (email, name, role, password_hash) VALUES ($1,'Temp Admin','super_admin',$2)`, [email, await hashSecret(OLD)]);
      await forgot(email, null);
      const token = tokenFromMail(email);
      expect((await http.post('/api/v1/auth/reset-password').send({ token, newPassword: NEW })).status).toBe(200);
      expect((await http.post('/api/v1/auth/platform/login').send({ email, password: NEW })).status).toBe(200);
    });

    it('does not store the token itself (hash only) and the dev outbox is readable in dev', async () => {
      const email = `fp8@${tenant.slug}.test`;
      await newUser(email);
      await forgot(email);
      const token = tokenFromMail(email);
      const row = (await owner.query('SELECT token_hash FROM password_resets WHERE id = $1', [token.split('.')[0]])).rows[0];
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(token).not.toContain(row.token_hash);
      const box = await http.get(`/api/v1/dev/outbox?to=${encodeURIComponent(email)}`);
      expect(box.body.data[0].text).toContain(token);
    });
  });
});
