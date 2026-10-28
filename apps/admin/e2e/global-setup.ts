import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = 'http://localhost:3190/api/v1';
export const STATE_FILE = join(__dirname, '.state.json');

/** Creates a fresh tenant through the platform API so every run starts from a known state. */
export default async function globalSetup() {
  const email = process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@rms.local';
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? 'ChangeMe123!';
  const login = await fetch(`${API}/auth/platform/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error(`Platform login failed (${login.status}). Did you run pnpm db:migrate && pnpm db:seed?`);
  const token = (await login.json()).data.accessToken;

  const slug = `e2e-${Date.now().toString(36)}`;
  const owner = { email: `owner@${slug}.test`, password: 'owner-password-1' };
  const res = await fetch(`${API}/platform/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: `E2E Cafe ${slug}`, slug, planCode: 'growth', ownerName: 'Olivia Owner', ownerEmail: owner.email, ownerPassword: owner.password }),
  });
  if (!res.ok) throw new Error(`Tenant creation failed: ${await res.text()}`);
  writeFileSync(STATE_FILE, JSON.stringify({ slug, name: `E2E Cafe ${slug}`, owner, platform: { email, password } }));
}
