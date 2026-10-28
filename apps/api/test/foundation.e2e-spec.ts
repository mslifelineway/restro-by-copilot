import 'reflect-metadata';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { config } from '../src/config';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RequireFeature } from '../src/common/decorators';
import { runMigrations } from '../src/db/migrate';
import { runSeed } from '../src/db/seed';

// Test-only route protected by a module entitlement.
@Controller('v1/_probe')
class ProbeController {
  @Get('kds') @RequireFeature('kds') kds() { return { ok: true }; }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

const run = Date.now().toString(36);
const PASSWORD = 'correct-horse-battery';

describe('P0 foundation', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminToken: string;
  const t: Record<'a' | 'b', { id: string; slug: string; token: string; outletId: string }> = {} as never;

  const login = async (slug: string, email: string, password = PASSWORD) =>
    request(app.getHttpServer()).post('/api/v1/auth/login').send({ tenantSlug: slug, email, password });

  beforeAll(async () => {
    await runMigrations();
    await runSeed();
    const mod = await Test.createTestingModule({ imports: [AppModule, ProbeModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());

    const r = await http.post('/api/v1/auth/platform/login').send({ email: config.platformAdminEmail, password: config.platformAdminPassword });
    expect(r.status).toBe(200);
    adminToken = r.body.data.accessToken;

    for (const k of ['a', 'b'] as const) {
      const slug = `t${k}-${run}`;
      const created = await http.post('/api/v1/platform/tenants').set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Tenant ${k}`, slug, planCode: 'starter', ownerName: 'Owner', ownerEmail: `owner@${slug}.test`, ownerPassword: PASSWORD });
      expect(created.status).toBe(201);
      const l = await login(slug, `owner@${slug}.test`);
      expect(l.status).toBe(200);
      t[k] = { id: created.body.data.id, slug, token: l.body.data.accessToken, outletId: created.body.data.outletId };
    }
  });

  afterAll(async () => { await app.close(); });

  const as = (k: 'a' | 'b') => ({ Authorization: `Bearer ${t[k].token}` });

  describe('tenant isolation (RLS)', () => {
    it('each tenant only sees its own outlets via the API', async () => {
      const a = await http.get('/api/v1/outlets').set(as('a'));
      expect(a.body.data.map((o: { id: string }) => o.id)).toEqual([t.a.outletId]);
      const b = await http.get('/api/v1/outlets').set(as('b'));
      expect(b.body.data.map((o: { id: string }) => o.id)).toEqual([t.b.outletId]);
    });

    it('database blocks cross-tenant reads/writes even with raw SQL as the app role', async () => {
      const c = new Client({ connectionString: config.databaseUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.a.id]);
        expect((await c.query('SELECT id FROM outlets WHERE id = $1', [t.b.outletId])).rowCount).toBe(0);
        expect((await c.query(`UPDATE outlets SET name = 'x' WHERE id = $1`, [t.b.outletId])).rowCount).toBe(0);
        await expect(c.query(`INSERT INTO outlets (tenant_id, name, code) VALUES ($1,'evil','EVIL')`, [t.b.id])).rejects.toThrow(/row-level security/);
        await c.query('ROLLBACK');
        // no tenant context at all => nothing visible
        expect((await c.query('SELECT id FROM users')).rowCount).toBe(0);
      } finally { await c.end(); }
    });

    it('audit log is append-only for the app role', async () => {
      const c = new Client({ connectionString: config.databaseUrl });
      await c.connect();
      try {
        await expect(c.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
      } finally { await c.end(); }
    });
  });

  describe('auth', () => {
    it('rejects bad credentials generically and unauthenticated requests', async () => {
      expect((await login(t.a.slug, `owner@${t.a.slug}.test`, 'wrong-password-xx')).status).toBe(401);
      expect((await login('no-such-tenant', 'x@y.test')).status).toBe(401);
      expect((await http.get('/api/v1/outlets')).status).toBe(401);
    });

    it('locks the account after repeated failures', async () => {
      const slug = t.b.slug;
      const email = `owner@${slug}.test`;
      for (let i = 0; i < 5; i++) await login(slug, email, 'bad-password-xx');
      expect((await login(slug, email)).status).toBe(429);
    });

    it('platform tokens cannot call tenant routes and vice versa', async () => {
      expect((await http.get('/api/v1/outlets').set('Authorization', `Bearer ${adminToken}`)).status).toBe(403);
      expect((await http.get('/api/v1/platform/tenants').set(as('a'))).status).toBe(403);
    });
  });

  describe('RBAC', () => {
    let cashierToken: string;
    it('cashier with PIN can log in but is denied user management', async () => {
      const roles = (await http.get('/api/v1/roles').set(as('a'))).body.data as { id: string; name: string }[];
      const cashier = roles.find((r) => r.name === 'Cashier')!;
      const email = `cash@${t.a.slug}.test`;
      const u = await http.post('/api/v1/users').set(as('a')).send({ email, name: 'Cash', pin: '123456', assignments: [{ roleId: cashier.id }] });
      expect(u.status).toBe(201);
      const l = await http.post('/api/v1/auth/pin-login').send({ tenantSlug: t.a.slug, email, pin: '123456' });
      expect(l.status).toBe(200);
      cashierToken = l.body.data.accessToken;
      const denied = await http.get('/api/v1/users').set('Authorization', `Bearer ${cashierToken}`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
      const me = await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${cashierToken}`);
      expect(me.body.data.permissions['discount:apply']).toEqual({ maxPercent: 10 });
    });

    it('outlet-scoped assignment only applies to that outlet', async () => {
      const roles = (await http.get('/api/v1/roles').set(as('a'))).body.data as { id: string; name: string }[];
      const mgr = roles.find((r) => r.name === 'Manager')!;
      const second = await http.post('/api/v1/outlets').set(as('a')).send({ name: 'Second', code: 'SECOND' });
      // starter plan = 1 outlet
      expect(second.status).toBe(403);
      expect(second.body.error.code).toBe('PLAN_LIMIT_REACHED');
      const email = `mgr@${t.a.slug}.test`;
      const u = await http.post('/api/v1/users').set(as('a')).send({ email, name: 'Mgr', password: PASSWORD, assignments: [{ roleId: mgr.id, outletId: t.a.outletId }] });
      expect(u.status).toBe(201);
      const tok = (await login(t.a.slug, email)).body.data.accessToken;
      const other = '11111111-1111-1111-1111-111111111111';
      expect((await http.get('/api/v1/outlets').set('Authorization', `Bearer ${tok}`).set('x-outlet-id', t.a.outletId)).status).toBe(200);
      expect((await http.get('/api/v1/outlets').set('Authorization', `Bearer ${tok}`).set('x-outlet-id', other)).status).toBe(403);
    });

    it('system roles are immutable; unknown permissions are rejected', async () => {
      const roles = (await http.get('/api/v1/roles').set(as('a'))).body.data as { id: string; name: string }[];
      const owner = roles.find((r) => r.name === 'Owner')!;
      expect((await http.put(`/api/v1/roles/${owner.id}/permissions`).set(as('a')).send({ permissions: [] })).status).toBe(403);
      expect((await http.post('/api/v1/roles').set(as('a')).send({ name: 'Bad', permissions: [{ permission: 'nuke:all' }] })).status).toBe(400);
    });
  });

  describe('entitlements / feature flags', () => {
    const adm = () => ({ Authorization: `Bearer ${adminToken}` });
    const kdsProbe = (k: 'a' | 'b') => http.get('/api/v1/_probe/kds').set(as(k));

    it('plan default: starter has no kds, guard blocks with FEATURE_DISABLED', async () => {
      const r = await kdsProbe('a');
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('FEATURE_DISABLED');
    });

    it('tenant override enables it, only for that tenant, and is audited', async () => {
      const r = await http.put(`/api/v1/platform/tenants/${t.a.id}/features/kds`).set(adm()).send({ enabled: true, reason: 'pilot customer' });
      expect(r.status).toBe(200);
      expect((await kdsProbe('a')).status).toBe(200);
      expect((await kdsProbe('b')).status).toBe(403);
      const hist = await http.get(`/api/v1/platform/flag-history?tenantId=${t.a.id}`).set(adm());
      expect(hist.body.data[0]).toMatchObject({ feature_key: 'kds', action: 'override_set', reason: 'pilot customer' });
    });

    it('dependencies: disabling a parent disables dependants', async () => {
      await http.put(`/api/v1/platform/tenants/${t.a.id}/features/order.course_firing`).set(adm()).send({ enabled: true, reason: 'pilot customer' });
      const eff = async () => (await http.get(`/api/v1/platform/tenants/${t.a.id}/features`).set(adm())).body.data as { key: string; enabled: boolean; source: string }[];
      expect((await eff()).find((e) => e.key === 'order.course_firing')!.enabled).toBe(true);
      await http.put(`/api/v1/platform/tenants/${t.a.id}/features/kds`).set(adm()).send({ enabled: false, reason: 'rollback test' });
      expect((await eff()).find((e) => e.key === 'order.course_firing')).toMatchObject({ enabled: false, source: 'dependency' });
    });

    it('expired overrides are ignored', async () => {
      await http.put(`/api/v1/platform/tenants/${t.a.id}/features/kds`).set(adm())
        .send({ enabled: true, reason: 'temp', expiresAt: new Date(Date.now() - 1000).toISOString() });
      const eff = (await http.get(`/api/v1/platform/tenants/${t.a.id}/features`).set(adm())).body.data as { key: string; enabled: boolean }[];
      expect(eff.find((e) => e.key === 'kds')!.enabled).toBe(false);
    });

    it('global kill switch beats every override, and releasing it restores', async () => {
      await http.put(`/api/v1/platform/tenants/${t.a.id}/features/kds`).set(adm()).send({ enabled: true, reason: 'pilot customer' });
      await new Promise((r) => setTimeout(r, 0));
      expect((await http.put('/api/v1/platform/features/kds/kill-switch').set(adm()).send({ on: true, reason: 'incident 42' })).status).toBe(200);
      expect((await kdsProbe('a')).status).toBe(403);
      await http.put('/api/v1/platform/features/kds/kill-switch').set(adm()).send({ on: false, reason: 'incident resolved' });
      expect((await kdsProbe('a')).status).toBe(200);
    });

    it('overrides require a reason', async () => {
      const r = await http.put(`/api/v1/platform/tenants/${t.a.id}/features/kds`).set(adm()).send({ enabled: true });
      expect(r.status).toBe(400);
    });
  });

  describe('tenant lifecycle', () => {
    it('suspending a tenant blocks its tokens immediately; slug conflicts are rejected', async () => {
      const adm = { Authorization: `Bearer ${adminToken}` };
      expect((await http.post('/api/v1/platform/tenants').set(adm).send({ name: 'Dup', slug: t.a.slug, ownerName: 'Dup Owner', ownerEmail: 'o@dup.test', ownerPassword: PASSWORD })).status).toBe(409);
      expect((await http.patch(`/api/v1/platform/tenants/${t.a.id}/status`).set(adm).send({ status: 'suspended' })).status).toBe(200);
      expect((await http.get('/api/v1/outlets').set(as('a'))).status).toBe(403);
      expect((await login(t.a.slug, `owner@${t.a.slug}.test`)).status).toBe(401);
      await http.patch(`/api/v1/platform/tenants/${t.a.id}/status`).set(adm).send({ status: 'active' });
      expect((await http.get('/api/v1/outlets').set(as('a'))).status).toBe(200);
    });
  });

  describe('response contract', () => {
    const adm = () => ({ Authorization: `Bearer ${adminToken}` });
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it('success envelope: single object', async () => {
      const r = await http.get(`/api/v1/platform/tenants/${t.a.id}`).set(adm());
      expect(r.body).toMatchObject({
        success: true, statusCode: 200, message: 'Tenant fetched successfully',
        path: `/api/v1/platform/tenants/${t.a.id}`, data: { id: t.a.id },
      });
      expect(r.body.requestId).toMatch(UUID);
      expect(r.headers['x-request-id']).toBe(r.body.requestId);
      expect(new Date(r.body.timestamp).toISOString()).toBe(r.body.timestamp);
      expect(r.body.meta).toBeUndefined();
    });

    it('success envelope: paginated list', async () => {
      const r = await http.get('/api/v1/platform/tenants?page=1&limit=1').set(adm());
      expect(r.body.success).toBe(true);
      expect(Array.isArray(r.body.data)).toBe(true);
      expect(r.body.data).toHaveLength(1);
      const p = r.body.meta.pagination;
      expect(p).toMatchObject({ page: 1, limit: 1, hasNextPage: true, hasPreviousPage: false });
      expect(p.totalItems).toBeGreaterThanOrEqual(2);
      expect(p.totalPages).toBe(Math.ceil(p.totalItems / 1));
      expect(r.body.path).toBe('/api/v1/platform/tenants?page=1&limit=1');
    });

    it('rejects out-of-range pagination with VALIDATION_FAILED', async () => {
      const r = await http.get('/api/v1/platform/tenants?limit=1000').set(adm());
      expect(r.status).toBe(400);
      expect(r.body.error.details[0]).toMatchObject({ field: 'limit', rule: 'max' });
    });

    it('error envelope: domain error', async () => {
      const r = await http.get('/api/v1/platform/tenants/11111111-1111-1111-1111-111111111111').set(adm());
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ success: false, statusCode: 404, error: { code: 'TENANT_NOT_FOUND', message: 'Tenant not found' } });
      expect(r.body.data).toBeUndefined();
      expect(r.body.requestId).toMatch(UUID);
    });

    it('error envelope: validation details with nested field paths', async () => {
      const v = await http.post('/api/v1/platform/tenants').set(adm()).send({ name: 'A', slug: 'Bad Slug', ownerEmail: 'nope', ownerName: 'Owner', ownerPassword: 'short' });
      expect(v.status).toBe(400);
      expect(v.body).toMatchObject({ success: false, statusCode: 400, error: { code: 'VALIDATION_FAILED', message: 'Validation failed' } });
      const fields = v.body.error.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['name', 'slug', 'ownerEmail', 'ownerPassword']));
      expect(v.body.error.details[0]).toEqual({ field: expect.any(String), rule: expect.any(String), message: expect.any(String) });
    });

    it('error envelope: unauthenticated and unknown route', async () => {
      const u = await http.get('/api/v1/outlets');
      expect(u.body).toMatchObject({ success: false, statusCode: 401, error: { code: 'AUTH_TOKEN_MISSING' } });
      const n = await http.get('/api/v1/nope').set(adm());
      expect(n.body).toMatchObject({ success: false, statusCode: 404, error: { code: 'NOT_FOUND' } });
    });

    it('echoes a valid inbound x-request-id and ignores junk', async () => {
      const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
      expect((await http.get('/health').set('x-request-id', id)).body.requestId).toBe(id);
      expect((await http.get('/health').set('x-request-id', 'junk')).body.requestId).toMatch(UUID);
    });
  });
});
