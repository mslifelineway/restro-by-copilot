import 'reflect-metadata';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { config } from '../src/config';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Public } from '../src/common/decorators';
import { runMigrations } from '../src/db/migrate';
import { runSeed } from '../src/db/seed';

@Controller('v1/_throttle')
class ThrottleProbe {
  @Public() @Throttle({ default: { limit: 2, ttl: 60_000 } }) @Get() ping() { return { ok: true }; }
}
@Module({ controllers: [ThrottleProbe] })
class ProbeModule {}

const run = `${Date.now().toString(36)}x`;
const PASSWORD = 'correct-horse-battery';

describe('P0 completion: sessions, devices, idempotency, hardening', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: string;
  let tenant: { id: string; slug: string; outletId: string; email: string };
  let ownerTokens: { accessToken: string; refreshToken: string };

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const owner = () => bearer(ownerTokens.accessToken);
  const login = (email: string, extra: object = {}) =>
    http.post('/api/v1/auth/login').send({ tenantSlug: tenant.slug, email, password: PASSWORD, ...extra });
  const addUser = async (email: string, roleName: string) => {
    const roles = (await http.get('/api/v1/roles').set(owner())).body.data as { id: string; name: string }[];
    const r = await http.post('/api/v1/users').set(owner()).send({ email, name: 'Staff', password: PASSWORD, assignments: [{ roleId: roles.find((x) => x.name === roleName)!.id }] });
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  };

  beforeAll(async () => {
    await runMigrations();
    await runSeed();
    const mod = await Test.createTestingModule({ imports: [AppModule, ProbeModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());

    admin = (await http.post('/api/v1/auth/platform/login').send({ email: config.platformAdminEmail, password: config.platformAdminPassword })).body.data.accessToken;
    const slug = `p0c-${run}`;
    const email = `owner@${slug}.test`;
    const c = await http.post('/api/v1/platform/tenants').set(bearer(admin))
      .send({ name: 'P0C', slug, planCode: 'growth', ownerName: 'Owner', ownerEmail: email, ownerPassword: PASSWORD });
    expect(c.status).toBe(201);
    tenant = { id: c.body.data.id, slug, outletId: c.body.data.outletId, email };
    ownerTokens = (await login(email)).body.data;
  });
  afterAll(async () => { await app.close(); });

  describe('refresh-token sessions', () => {
    it('login returns an access+refresh pair', () => {
      expect(ownerTokens.refreshToken).toMatch(/^[0-9a-f-]{36}\.[\w-]+$/);
    });

    it('rotates on refresh; reusing the old token revokes the whole family', async () => {
      config.refreshReuseLeewaySeconds = 0;
      const first = (await login(tenant.email)).body.data;
      const r1 = await http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(r1.status).toBe(200);
      expect(r1.body.data.refreshToken).not.toBe(first.refreshToken);
      expect((await http.get('/api/v1/auth/me').set(bearer(r1.body.data.accessToken))).status).toBe(200);

      const reuse = await http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      // the legitimately rotated token is dead too, and so is the access token of that family
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken })).status).toBe(401);
      const me = await http.get('/api/v1/auth/me').set(bearer(r1.body.data.accessToken));
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('SESSION_REVOKED');
    });

    it('tolerates a just-rotated token inside the leeway (parallel requests) and keeps old access tokens alive', async () => {
      config.refreshReuseLeewaySeconds = 30;
      try {
        const first = (await login(tenant.email)).body.data;
        const [a, b] = await Promise.all([
          http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }),
          http.post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken }),
        ]);
        expect([a.status, b.status]).toEqual([200, 200]);
        // the access token issued BEFORE rotation still works (in-flight requests)
        expect((await http.get('/api/v1/auth/me').set(bearer(first.accessToken))).status).toBe(200);
        // and the user is not logged out: the newest token is usable
        expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: b.body.data.refreshToken })).status).toBe(200);
        // logging out from ANY token in the chain ends the whole chain
        expect((await http.post('/api/v1/auth/logout').set(bearer(first.accessToken))).status).toBe(200);
        expect((await http.get('/api/v1/auth/me').set(bearer(a.body.data.accessToken))).body.error.code).toBe('SESSION_REVOKED');
        expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: b.body.data.refreshToken })).status).toBe(401);
      } finally { config.refreshReuseLeewaySeconds = 10; }
    });

    it('rejects garbage and tampered refresh tokens', async () => {
      const t = (await login(tenant.email)).body.data.refreshToken as string;
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: t.slice(0, -3) + 'xxx' })).body.error.code).toBe('REFRESH_TOKEN_INVALID');
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: 'a'.repeat(40) })).body.error.code).toBe('REFRESH_TOKEN_INVALID');
    });

    it('logout ends the session immediately for access and refresh tokens', async () => {
      const s = (await login(tenant.email)).body.data;
      expect((await http.post('/api/v1/auth/logout').set(bearer(s.accessToken))).status).toBe(200);
      expect((await http.get('/api/v1/auth/me').set(bearer(s.accessToken))).body.error.code).toBe('SESSION_REVOKED');
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
    });

    it('lists own sessions and lets the user end another one', async () => {
      const other = (await login(tenant.email)).body.data;
      const list = (await http.get('/api/v1/sessions').set(owner())).body.data as { id: string; current: boolean }[];
      expect(list.some((s) => s.current)).toBe(true);
      const target = list.find((s) => !s.current)!;
      expect((await http.delete(`/api/v1/sessions/${target.id}`).set(owner())).status).toBe(200);
      void other;
    });

    it('works for platform users too', async () => {
      const p = (await http.post('/api/v1/auth/platform/login').send({ email: config.platformAdminEmail, password: config.platformAdminPassword })).body.data;
      const r = await http.post('/api/v1/auth/refresh').send({ refreshToken: p.refreshToken });
      expect(r.status).toBe(200);
      expect((await http.get('/api/v1/platform/tenants').set(bearer(r.body.data.accessToken))).status).toBe(200);
    });
  });

  describe('user management & force logout', () => {
    it('force-logout and disabling end a user\'s sessions; disabled users cannot sign in', async () => {
      const email = `cash1@${tenant.slug}.test`;
      const uid = await addUser(email, 'Cashier');
      const s = (await login(email)).body.data;
      expect((await http.get('/api/v1/auth/me').set(bearer(s.accessToken))).status).toBe(200);

      const fl = await http.post(`/api/v1/users/${uid}/force-logout`).set(owner());
      expect(fl.body.data.sessionsEnded).toBeGreaterThanOrEqual(1);
      expect((await http.get('/api/v1/auth/me').set(bearer(s.accessToken))).status).toBe(401);

      const s2 = (await login(email)).body.data;
      expect((await http.patch(`/api/v1/users/${uid}`).set(owner()).send({ status: 'disabled' })).status).toBe(200);
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: s2.refreshToken })).status).toBe(401);
      expect((await login(email)).status).toBe(401);
    });

    it('cannot disable yourself', async () => {
      const me = (await http.get('/api/v1/auth/me').set(owner())).body.data.userId;
      const r = await http.patch(`/api/v1/users/${me}`).set(owner()).send({ status: 'disabled' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('CANNOT_DISABLE_SELF');
    });

    it('cashiers cannot force-logout others', async () => {
      const email = `cash2@${tenant.slug}.test`;
      await addUser(email, 'Cashier');
      const tok = (await login(email)).body.data.accessToken;
      const r = await http.post(`/api/v1/users/${tenant.outletId}/force-logout`).set(bearer(tok));
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('device registration', () => {
    it('registered device can sign in; unknown/other-tenant device cannot; revoke ends its sessions', async () => {
      const d = await http.post('/api/v1/devices').set(owner()).send({ name: 'Counter 1', platform: 'android', outletId: tenant.outletId });
      expect(d.status).toBe(201);
      const deviceId = d.body.data.id;

      const s = await login(tenant.email, { deviceId });
      expect(s.status).toBe(200);
      const bad = await login(tenant.email, { deviceId: randomUUID() });
      expect(bad.status).toBe(403);
      expect(bad.body.error.code).toBe('DEVICE_NOT_REGISTERED');

      const list = await http.get('/api/v1/devices').set(owner());
      expect(list.body.meta.pagination.totalItems).toBeGreaterThanOrEqual(1);

      const rev = await http.post(`/api/v1/devices/${deviceId}/revoke`).set(owner());
      expect(rev.body.data.sessionsEnded).toBeGreaterThanOrEqual(1);
      expect((await http.get('/api/v1/auth/me').set(bearer(s.body.data.accessToken))).status).toBe(401);
      expect((await http.post('/api/v1/auth/refresh').send({ refreshToken: s.body.data.refreshToken })).status).toBe(401);
      expect((await login(tenant.email, { deviceId })).body.error.code).toBe('DEVICE_NOT_REGISTERED');
    });

    it('validates input and requires permission', async () => {
      expect((await http.post('/api/v1/devices').set(owner()).send({ name: 'x', platform: 'toaster' })).body.error.code).toBe('VALIDATION_FAILED');
      const email = `waiter@${tenant.slug}.test`;
      await addUser(email, 'Waiter');
      const tok = (await login(email)).body.data.accessToken;
      expect((await http.get('/api/v1/devices').set(bearer(tok))).status).toBe(403);
    });
  });

  describe('idempotency keys', () => {
    const post = (key: string | null, name: string) =>
      http.post('/api/v1/roles').set(owner()).set(key ? { 'Idempotency-Key': key } : {}).send({ name, permissions: [{ permission: 'menu:read' }] });

    it('replays the first result instead of executing twice', async () => {
      const key = `key-${run}-1`;
      const a = await post(key, `Role-${run}-a`);
      expect(a.status).toBe(201);
      const b = await post(key, `Role-${run}-a`);
      expect(b.status).toBe(201);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.data.id).toBe(a.body.data.id);
      expect(b.body.success).toBe(true);
      const roles = (await http.get('/api/v1/roles').set(owner())).body.data as { name: string }[];
      expect(roles.filter((r) => r.name === `Role-${run}-a`)).toHaveLength(1);
    });

    it('rejects the same key with a different request', async () => {
      const key = `key-${run}-2`;
      await post(key, `Role-${run}-b`);
      const r = await post(key, `Role-${run}-c`);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('releases the key when the first attempt fails so the client can retry', async () => {
      const key = `key-${run}-3`;
      const bad = await http.post('/api/v1/roles').set(owner()).set({ 'Idempotency-Key': key }).send({ name: `Role-${run}-d`, permissions: [{ permission: 'nuke:all' }] });
      expect(bad.status).toBe(400);
      const retry = await http.post('/api/v1/roles').set(owner()).set({ 'Idempotency-Key': key }).send({ name: `Role-${run}-d`, permissions: [{ permission: 'menu:read' }] });
      // different body => hash differs, but the failed attempt released the key, so it executes
      expect(retry.status).toBe(201);
    });

    it('validates the key format; writes without a key are unaffected', async () => {
      expect((await post('short', `Role-${run}-e`)).body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
      expect((await post(null, `Role-${run}-f`)).status).toBe(201);
    });
  });

  describe('outlet management', () => {
    it('updates an outlet but refuses to delete the last one', async () => {
      expect((await http.patch(`/api/v1/outlets/${tenant.outletId}`).set(owner()).send({ name: 'Renamed', gstin: '29ABCDE1234F1Z5' })).status).toBe(200);
      const list = (await http.get('/api/v1/outlets').set(owner())).body.data;
      expect(list[0].name).toBe('Renamed');
      const del = await http.delete(`/api/v1/outlets/${tenant.outletId}`).set(owner());
      expect(del.status).toBe(409);
      expect(del.body.error.code).toBe('LAST_OUTLET');
    });

    it('can delete a non-last outlet', async () => {
      const o = await http.post('/api/v1/outlets').set(owner()).send({ name: 'Second', code: 'SECOND' });
      expect(o.status).toBe(201);
      expect((await http.delete(`/api/v1/outlets/${o.body.data.id}`).set(owner())).status).toBe(200);
    });
  });

  describe('hardening', () => {
    it('rate limits per IP with the standard error envelope', async () => {
      const get = () => http.get('/api/v1/_throttle');
      expect((await get()).status).toBe(200);
      expect((await get()).status).toBe(200);
      const limited = await get();
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ success: false, statusCode: 429, error: { code: 'TOO_MANY_REQUESTS' } });
    });

    it('sets security headers', async () => {
      const r = await http.get('/health');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-powered-by']).toBeUndefined();
    });
  });
});
