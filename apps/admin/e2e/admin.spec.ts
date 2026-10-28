import { expect, Page, test } from '@playwright/test';

const API = 'http://localhost:3190/api/v1';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** App error messages (excludes Next's hidden route announcer, which also has role=alert). */
const alerts = (page: Page) => page.locator('[role=alert]:not(#__next-route-announcer__)');

/** Sidebar link (the overview page also has in-content links with similar names). */
const nav = (page: Page, name: string) => page.getByRole('navigation').getByRole('link', { name, exact: true });

const state = () => JSON.parse(readFileSync(join(__dirname, '.state.json'), 'utf8')) as {
  slug: string; name: string; owner: { email: string; password: string }; platform: { email: string; password: string };
};

async function signInTenant(page: Page, email: string, password: string) {
  const s = state();
  await page.goto('/login');
  await page.waitForLoadState('networkidle'); // let React hydrate before typing
  await page.getByRole('tab', { name: 'Restaurant' }).click();
  await page.getByLabel('Restaurant ID').fill(s.slug);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe.configure({ mode: 'serial' });

test('unauthenticated visitors are sent to the login page', async ({ page }) => {
  await page.goto('/outlets');
  await expect(page).toHaveURL(/\/login$/);
});

test('login shows an error for a wrong password and field errors for empty input', async ({ page }) => {
  const s = state();
  await signInTenant(page, s.owner.email, 'definitely-wrong-1');
  await expect(alerts(page)).toContainText(/invalid credentials/i);
  await page.getByLabel('Email').fill('');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Enter a valid email')).toBeVisible();
});

test('platform admin signs in and sees the new tenant', async ({ page }) => {
  const s = state();
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: 'Platform admin' }).click();
  await page.getByLabel('Email').fill(s.platform.email);
  await page.getByLabel('Password').fill(s.platform.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/tenants$/);
  await expect(page.getByRole('link', { name: s.name })).toBeVisible();
  // a platform user cannot use the tenant console
  await page.goto('/outlets');
  await expect(page).toHaveURL(/\/tenants$/);
});

test.describe('restaurant owner', () => {
  test('signs in and sees plan usage on the overview', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: s.name })).toBeVisible();
    await expect(page.getByText('Outlets: 1 / 3')).toBeVisible();
  });

  test('creates an outlet, sees validation, and usage updates', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Outlets').click();
    await page.getByRole('button', { name: 'New outlet' }).click();
    await page.getByLabel('Code').fill('bad code');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Uppercase letters/)).toBeVisible();
    await page.getByLabel('Outlet name').fill('Airport Kiosk');
    await page.getByLabel('Code').fill('AIRPORT');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('cell', { name: 'Airport Kiosk' })).toBeVisible();
    await nav(page, 'Subscription').click();
    await expect(page.getByRole('progressbar', { name: 'Outlets' })).toHaveAttribute('aria-valuenow', '2');
  });

  test('creates a custom role with a limit and a user assigned to it', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Roles & permissions').click();
    await page.getByRole('button', { name: 'New role' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role name').fill('Shift Lead');
    await dialog.getByRole('checkbox', { name: 'menu:read' }).check();
    await dialog.getByRole('checkbox', { name: 'discount:apply' }).check();
    await dialog.getByLabel('discount:apply Max discount %').fill('5');
    await dialog.getByRole('button', { name: 'Create role' }).click();
    await expect(page.getByRole('button', { name: /Shift Lead/ })).toBeVisible();
    await expect(page.getByLabel('discount:apply Max discount %')).toHaveValue('5');

    await nav(page, 'Users').click();
    await page.getByRole('button', { name: 'New user' }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Name', { exact: true }).fill('Casey Cashier');
    await form.getByLabel('Email').fill(`casey@${s.slug}.test`);
    await form.getByLabel('Password').fill('casey-password-1');
    await form.getByLabel('Role').selectOption({ label: 'Cashier' });
    await form.getByRole('button', { name: 'Create user' }).click();
    const row = page.getByRole('row', { name: /Casey Cashier/ });
    await expect(row).toContainText('Cashier');
  });

  test('registers a device and shows its id; settings can be saved', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Devices').click();
    await page.getByRole('button', { name: 'Register device' }).click();
    await page.getByLabel('Device name').fill('Counter 1 tablet');
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByTestId('device-id')).toHaveText(/^[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('cell', { name: /Counter 1 tablet/ })).toBeVisible();

    await nav(page, 'Settings').click();
    await page.getByLabel('Business name').fill(`${s.name} (renamed)`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Settings saved');
  });

  test('stays signed in after the access cookie expires (silent refresh)', async ({ page, context }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await expect(page).toHaveURL(/\/dashboard$/);
    await context.clearCookies({ name: 'rms_admin_session' });
    await nav(page, 'Outlets').click();
    await expect(page.getByRole('cell', { name: 'Airport Kiosk' })).toBeVisible();
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name === 'rms_admin_session' && c.httpOnly)).toBe(true);
  });

  test('sign out ends the session; going back does not restore access', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('cashier (limited role)', () => {
  test('only sees what their permissions allow, and the API refuses the rest', async ({ page }) => {
    const s = state();
    await signInTenant(page, `casey@${s.slug}.test`, 'casey-password-1');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(nav(page, 'Users')).toHaveCount(0);
    await expect(nav(page, 'Roles & permissions')).toHaveCount(0);
    await expect(nav(page, 'Account')).toBeVisible();
    await page.goto('/users'); // direct URL: page loads, API denies
    await expect(alerts(page)).toContainText(/permission/i);
  });
});

test.describe('passwords', () => {
  const riley = () => ({ email: `riley@${state().slug}.test` });
  const START = 'riley-start-password-1';
  const RESET = 'riley-reset-password-2';
  const CHANGED = 'riley-changed-password-3';

  test('setup: owner creates a user to test password flows with', async ({ request }) => {
    const s = state();
    const login = await request.post(`${API}/auth/login`, { data: { tenantSlug: s.slug, email: s.owner.email, password: s.owner.password } });
    const token = (await login.json()).data.accessToken;
    const roles = (await (await request.get(`${API}/roles`, { headers: { authorization: `Bearer ${token}` } })).json()).data as { id: string; name: string }[];
    const r = await request.post(`${API}/users`, {
      headers: { authorization: `Bearer ${token}` },
      data: { email: riley().email, name: 'Riley Reset', password: START, assignments: [{ roleId: roles.find((x) => x.name === 'Waiter')!.id }] },
    });
    expect(r.status()).toBe(201);
  });

  test('forgot password: request a link, reset with it, and the old password stops working', async ({ page, request }) => {
    const s = state();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.waitForLoadState('networkidle');

    // client-side validation
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('Restaurant ID is required')).toBeVisible();

    await page.getByLabel('Restaurant ID').fill(s.slug);
    await page.getByLabel('Email').fill(riley().email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText("we've sent a link");

    // a typo'd account gets the SAME confirmation (no account enumeration)
    await page.goto('/forgot-password');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Restaurant ID').fill(s.slug);
    await page.getByLabel('Email').fill(`nobody@${s.slug}.test`);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText("we've sent a link");

    // dev mail transport: read the link the API "emailed"
    const box = await (await request.get(`${API}/dev/outbox`, { params: { to: riley().email } })).json();
    const link = /(http\S+\/reset-password\?token=\S+)/.exec(box.data[0].text)![1];
    const path = new URL(link).pathname + new URL(link).search;

    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await page.getByLabel(/^New password/).fill(RESET);
    await page.getByLabel('Confirm new password').fill('does-not-match-1');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByText('Passwords do not match')).toBeVisible();
    await page.getByLabel('Confirm new password').fill(RESET);
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('status')).toContainText('password has been updated');

    // the link is single use
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await page.getByLabel(/^New password/).fill('another-new-password-9');
    await page.getByLabel('Confirm new password').fill('another-new-password-9');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(alerts(page)).toContainText(/invalid or has expired/i);
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();

    // old password rejected, new one accepted
    await signInTenant(page, riley().email, START);
    await expect(alerts(page)).toContainText(/invalid credentials/i);
    await signInTenant(page, riley().email, RESET);
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('change password: wrong current password keeps you signed in; success signs out other sessions', async ({ page, browser }) => {
    await signInTenant(page, riley().email, RESET);
    await expect(page).toHaveURL(/\/dashboard$/);
    // a second browser session for the same user
    const other = await browser.newPage();
    await signInTenant(other, riley().email, RESET);
    await expect(other).toHaveURL(/\/dashboard$/);

    await nav(page, 'Account').click();
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Current password').fill('not-my-password-1');
    await page.getByLabel(/^New password/).fill(CHANGED);
    await page.getByLabel('Confirm new password').fill(CHANGED);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Current password is incorrect')).toBeVisible();
    await expect(page).toHaveURL(/\/security$/); // a wrong password is not a logout

    await page.getByLabel('Current password').fill(RESET);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toContainText('other session');

    // this session survives; the other browser's session is ended (its next API call fails -> login)
    await nav(page, 'Devices').or(nav(page, 'Overview')).first().click();
    await expect(page).not.toHaveURL(/\/login$/);
    await other.reload();
    await expect(other).toHaveURL(/\/login$/);
    await other.close();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await signInTenant(page, riley().email, RESET);
    await expect(alerts(page)).toContainText(/invalid credentials/i);
    await signInTenant(page, riley().email, CHANGED);
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('platform admin has an Account page with the same change-password form', async ({ page }) => {
    const s = state();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: 'Platform admin' }).click();
    await page.getByLabel('Email').fill(s.platform.email);
    await page.getByLabel('Password').fill(s.platform.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await nav(page, 'Account').click();
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Current password').fill('wrong-current-password');
    await page.getByLabel(/^New password/).fill('some-new-platform-pass-1');
    await page.getByLabel('Confirm new password').fill('some-new-platform-pass-1');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Current password is incorrect')).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
  });
});
