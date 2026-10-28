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

  test('opens the offline sync inbox and explains the manual review behavior', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Offline sync inbox').click();
    await expect(page).toHaveURL(/\/sync-inbox$/);
    await expect(page.getByRole('heading', { name: 'Offline sync inbox' })).toBeVisible();
    await expect(page.getByText(/does not apply it to orders or payments/i)).toBeVisible();
    await expect(page.getByText('No offline events in this status')).toBeVisible();
  });

  test('opens, adjusts, and closes a cashier shift, then shows it in the report', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Cashier shifts').click();
    await expect(page).toHaveURL(/\/cashier-shifts$/);
    await expect(page.getByRole('heading', { name: 'Cashier shifts' })).toBeVisible();
    await page.getByRole('button', { name: 'Open shift' }).click();
    await page.getByLabel('Opening cash (paise)').fill('10000');
    await page.getByRole('button', { name: 'Open shift' }).last().click();
    await expect(page.getByRole('status')).toHaveText('Cashier shift opened.');

    await page.getByRole('button', { name: 'Add cash adjustment' }).click();
    await page.getByLabel('Amount (paise)').fill('0');
    await page.getByLabel('Reason').fill('x');
    await page.getByRole('button', { name: 'Record adjustment' }).click();
    await expect(page.getByText('Enter an amount greater than zero in paise')).toBeVisible();
    await page.getByLabel('Amount (paise)').fill('1500');
    await page.getByLabel('Reason').fill('Float top-up');
    await page.getByRole('button', { name: 'Record adjustment' }).click();
    await expect(page.getByRole('status')).toHaveText('Cash adjustment recorded.');

    await page.getByRole('button', { name: 'Close shift' }).click();
    await page.getByLabel('Counted cash (paise)').fill('11500');
    await page.getByRole('button', { name: 'Close shift' }).last().click();
    await expect(page.getByRole('status')).toHaveText('Cashier shift closed.');
    const closedShift = page.getByRole('row').filter({ hasText: 'CLOSED' });
    await expect(closedShift.getByRole('cell', { name: '₹115.00' }).first()).toBeVisible();
    await expect(closedShift.getByRole('cell', { name: '₹15.00' })).toBeVisible();
    await expect(closedShift.getByRole('cell', { name: '₹0.00' }).first()).toBeVisible();
  });

  test('opens billing and validates invoice lookup input', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Billing').click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    await page.getByLabel('Service charge').selectOption('FIXED');
    await page.getByLabel('Amount (paise)').fill('250');
    await page.getByRole('button', { name: 'Save billing settings' }).click();
    await expect(page.getByRole('status')).toHaveText('Billing settings saved.');
    await page.getByLabel('Service charge').selectOption('NONE');
    await page.getByRole('button', { name: 'Save billing settings' }).click();
    await expect(page.getByRole('status')).toHaveText('Billing settings saved.');
    await page.getByLabel('Invoice ID').fill('not-an-id');
    await page.getByRole('button', { name: 'Load invoice' }).click();
    await expect(alerts(page)).toContainText('Enter a valid invoice UUID');
    await expect(page.getByText('No ready orders are available to invoice.')).toBeVisible();
  });

  test('prints a loaded invoice from its printable invoice view', async ({ page }) => {
    const s = state();
    const invoiceId = 'c0d3a3b0-60b0-4b6a-9c08-2dc3eb55dc90';
    await page.addInitScript(() => {
      window.print = () => window.localStorage.setItem('invoice-print-invoked', 'yes');
    });
    await page.route(`**/api/bff/v1/invoices/${invoiceId}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        statusCode: 200,
        message: 'Invoice fetched successfully',
        data: {
          id: invoiceId,
          invoiceNumber: '26-27/A/000001',
          tenantName: 'E2E Restaurant',
          outletName: 'Main Outlet',
          outletGstin: '22AAAAA0000A1Z5',
          taxableAmount: '10000',
          cgstAmount: '250',
          sgstAmount: '250',
          igstAmount: '0',
          totalTax: '500',
          discountType: null,
          discountValue: '0',
          discountAmount: '0',
          serviceChargeAmount: '0',
          serviceChargeTaxableAmount: '0',
          serviceChargeTax: '0',
          serviceChargeTaxCode: null,
          tipAmount: '0',
          roundOffAmount: '0',
          totalAmount: '10500',
          paidAmount: '0',
          balanceAmount: '10500',
          paymentStatus: 'UNPAID',
          isVoided: false,
          createdAt: '2026-04-04T10:00:00.000Z',
          lines: [{
            id: 'b6f29177-ad77-4fc6-8a99-2868a429c61d',
            itemName: 'Paneer Tikka',
            variantName: 'Full',
            quantity: 1,
            discountAmount: '0',
            taxableAmount: '10000',
            totalTax: '500',
            totalAmount: '10500',
          }],
          payments: [],
          refunds: [],
          void: null,
        },
        timestamp: '2026-04-04T10:00:00.000Z',
        path: `/api/v1/invoices/${invoiceId}`,
        requestId: '4a860c43-334c-4980-a8c0-6a67d0ca0bf8',
      }),
    }));
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Billing').click();
    await page.getByLabel('Invoice ID').fill(invoiceId);
    await page.getByRole('button', { name: 'Load invoice' }).click();
    await expect(page.getByText('Paneer Tikka · Full')).toBeVisible();
    await page.getByRole('button', { name: 'Print invoice' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('invoice-print-invoked'))).toBe('yes');
  });

  test('manages menu categories, tax slabs, items, and variants', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Menu').click();
    await expect(page).toHaveURL(/\/menu$/);
    await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toBeVisible();

    await page.getByLabel('Category name').fill('E2E Menu Category');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByRole('status')).toHaveText('Category created.');
    await page.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByText('E2E Menu Category · inactive')).toBeVisible();
    await page.getByRole('button', { name: 'Activate' }).click();

    await page.getByLabel('Tax code').fill('GST_E2E');
    await page.getByLabel('CGST rate (basis points)').fill('900');
    await page.getByLabel('SGST rate (basis points)').fill('900');
    await page.getByLabel('IGST rate (basis points)').fill('1800');
    await page.getByRole('button', { name: 'Add tax slab' }).click();
    await expect(page.getByRole('status')).toHaveText('Tax slab created.');

    await page.getByLabel('Item name').fill('E2E Paneer Tikka');
    await page.locator('select').nth(1).selectOption({ label: 'E2E Menu Category' });
    await page.locator('select').nth(2).selectOption({ label: 'GST_E2E · GST 18.00%' });
    await page.getByRole('button', { name: 'Add menu item' }).click();
    await expect(page.getByRole('status')).toContainText('Menu item created');
    await page.getByRole('row').filter({ hasText: 'E2E Paneer Tikka' }).getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Description (optional)').fill('Updated item details');
    await page.getByRole('button', { name: 'Update menu item' }).click();
    await expect(page.getByRole('status')).toHaveText('Menu item updated.');
    await page.getByLabel('Variant name').fill('Regular');
    await page.getByLabel('Base price (paise)').fill('25000');
    await page.getByRole('button', { name: 'Add variant' }).click();
    await expect(page.getByRole('status')).toHaveText('Variant created.');
    await page.getByRole('row').filter({ hasText: 'Regular' }).getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Base price (paise)').fill('27500');
    await page.getByRole('button', { name: 'Update variant' }).click();
    await expect(page.getByRole('status')).toHaveText('Variant updated.');
    await expect(page.getByRole('row').filter({ hasText: 'Regular' })).toContainText('27500');
    await expect(page.getByRole('row').filter({ hasText: 'E2E Paneer Tikka' })).toContainText('Available');
  });

  test('manages floor tables and their availability', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Floor & tables').click();
    await expect(page).toHaveURL(/\/floor$/);
    await page.getByLabel('Table code').fill('E2E_01');
    await page.getByLabel('Table name').fill('E2E Table');
    await page.getByRole('textbox', { name: 'Section' }).fill('Patio');
    await page.getByRole('button', { name: 'Add table' }).click();
    await expect(page.getByRole('status')).toHaveText('Table added.');
    const table = page.locator('div.rounded-lg.border.bg-card').filter({ has: page.getByRole('heading', { name: 'E2E Table' }) });
    await table.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Table name').fill('E2E Patio Table');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Table details updated.');
    const updatedTable = page.locator('div.rounded-lg.border.bg-card').filter({ has: page.getByRole('heading', { name: 'E2E Patio Table' }) });
    await updatedTable.getByRole('button', { name: 'Reserve' }).click();
    await expect(page.getByRole('status')).toHaveText('Table status updated.');
    await expect(updatedTable).toContainText('RESERVED');
    await updatedTable.getByRole('button', { name: 'Mark available' }).click();
    await expect(page.getByRole('status')).toHaveText('Table status updated.');
    await updatedTable.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('status')).toHaveText('Table removed.');
  });

  test('opens the daily sales report with outlet business date', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Sales reports').click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(page.getByRole('heading', { name: 'Daily sales report' })).toBeVisible();
    await expect(page.getByText(/Business date \d{4}-\d{2}-\d{2} ·/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sales by item & category' })).toBeVisible();
    await expect(page.getByText('No invoices for this date.')).toBeVisible();
  });

  test('creates an inventory item and supplier, then partially receives a purchase order', async ({ page }) => {
    const s = state();
    await signInTenant(page, s.owner.email, s.owner.password);
    await nav(page, 'Inventory & purchasing').click();
    await expect(page).toHaveURL(/\/purchasing$/);
    await expect(page.getByRole('heading', { name: 'Inventory & purchasing' })).toBeVisible();

    await page.getByRole('button', { name: 'New inventory item' }).click();
    await page.getByLabel('Item name').fill('x');
    await page.getByRole('button', { name: 'Create item' }).click();
    await expect(page.getByText('Enter at least 2 characters')).toBeVisible();
    await page.getByLabel('Item name').fill('E2E Rice');
    await page.getByLabel('Reorder level').fill('2');
    await page.getByRole('button', { name: 'Create item' }).click();
    await expect(page.getByRole('status')).toHaveText('Inventory item created.');

    await page.getByRole('button', { name: 'New supplier' }).click();
    await page.getByLabel('Supplier name').fill('E2E Foods');
    await page.getByRole('button', { name: 'Save supplier' }).click();
    await expect(page.getByRole('status')).toHaveText('Supplier created.');

    await page.getByRole('button', { name: 'New purchase order' }).click();
    await page.getByLabel('Supplier').selectOption({ label: 'E2E Foods' });
    await page.getByLabel('Item 1').selectOption({ label: 'E2E Rice (KG)' });
    await page.getByLabel('Quantity').fill('10');
    await page.getByLabel('Unit cost (paise)').fill('5000');
    await page.getByRole('button', { name: 'Create purchase order' }).click();
    await expect(page.getByRole('status')).toHaveText('Purchase order created.');
    const orderRow = page.getByRole('row').filter({ hasText: 'E2E Foods' });
    await expect(orderRow).toContainText('ORDERED');

    await orderRow.getByRole('button', { name: 'Receive' }).click();
    await page.getByLabel(/E2E Rice — 0.000 received, 10.000 remaining/).fill('3');
    await page.getByRole('button', { name: 'Record receipt' }).click();
    await expect(page.getByRole('status')).toHaveText('Stock receipt recorded.');
    await expect(orderRow).toContainText('PARTIALLY RECEIVED');
    await expect(orderRow).toContainText('3.000 / 10.000');

    await orderRow.getByRole('button', { name: 'Receive' }).click();
    await page.getByLabel(/E2E Rice — 3.000 received, 7.000 remaining/).fill('7');
    await page.getByRole('button', { name: 'Record receipt' }).click();
    await expect(page.getByRole('status')).toHaveText('Stock receipt recorded.');
    await expect(orderRow).toContainText('RECEIVED');
    await expect(page.getByRole('cell', { name: '10.000' }).first()).toBeVisible();

    await nav(page, 'Inventory').click();
    await expect(page).toHaveURL(/\/inventory$/);
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
    await page.getByLabel('Inventory item').selectOption({ label: 'E2E Rice (KG)' });
    await page.getByLabel('Direction').selectOption('OUT');
    await page.getByLabel('Quantity').fill('1');
    await page.getByLabel('Reason').selectOption('WASTE');
    await page.getByRole('button', { name: 'Record movement' }).click();
    await expect(page.getByRole('status')).toHaveText('Stock movement recorded.');
    await expect(page.getByRole('row').filter({ hasText: 'E2E Rice' })).toContainText('9.000 KG');

    await page.getByLabel('Menu item').selectOption({ label: 'E2E Paneer Tikka' });
    await page.getByRole('button', { name: 'Add ingredient' }).click();
    await page.getByLabel('Ingredient 1').selectOption({ label: 'E2E Rice (KG)' });
    await page.getByLabel('Quantity per menu item').fill('0.100');
    await page.getByRole('button', { name: 'Save recipe' }).click();
    await expect(page.getByRole('status')).toHaveText('Recipe saved.');
    await expect(page.getByLabel('Ingredient 1')).toHaveValue(await page.getByLabel('Inventory item').inputValue());
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
    await expect(nav(page, 'Inventory & purchasing')).toHaveCount(0);
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
