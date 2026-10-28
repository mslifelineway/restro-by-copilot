export type PlanCode = 'trial' | 'starter' | 'growth' | 'enterprise';
export type FlagType = 'entitlement' | 'release' | 'kill_switch';

export interface FeatureDef {
  key: string;
  module: string;
  type: FlagType;
  description: string;
  /** Plans that include this feature by default. Add-on-only features list just 'enterprise'. */
  plans: PlanCode[];
  /** Feature is only effective when all of these are effective too. */
  dependsOn?: string[];
}

const S: PlanCode[] = ['trial', 'starter', 'growth', 'enterprise'];
const G: PlanCode[] = ['trial', 'growth', 'enterprise'];
const E: PlanCode[] = ['enterprise'];
const GE = G;

const f = (key: string, module: string, plans: PlanCode[], description: string, dependsOn?: string[]): FeatureDef =>
  ({ key, module, type: 'entitlement', plans, description, dependsOn });

/**
 * Module-level entitlement catalog (RMS doc M3A). Core features (billing, tax, audit log,
 * auth, basic orders/KOT) are deliberately NOT flagged.
 */
export const FEATURES: FeatureDef[] = [
  f('menu.combos', 'M4 Menu', S, 'Combo items'),
  f('menu.time_based', 'M4 Menu', G, 'Time-based menu and pricing'),
  f('menu.nutrition', 'M4 Menu', G, 'Nutrition and allergen info'),
  f('pos.einvoice', 'M5 POS', G, 'E-invoice / IRN'),
  f('pos.house_accounts', 'M5 POS', G, 'House / credit accounts'),
  f('pos.payment_links', 'M5 POS', G, 'Payment links'),
  f('tables.reservations', 'M6 Tables', G, 'Reservations'),
  f('tables.waitlist', 'M6 Tables', G, 'Waitlist'),
  f('events.banquet', 'M6 Tables', E, 'Banquet and party booking'),
  f('kds', 'M7 Orders', G, 'Kitchen display system'),
  f('order.course_firing', 'M7 Orders', G, 'Course management', ['kds']),
  f('qr_ordering', 'M8 Omnichannel', G, 'Table QR ordering'),
  f('online.website', 'M8 Omnichannel', GE, 'Own ordering website'),
  f('aggregator.zomato', 'M8 Omnichannel', GE, 'Zomato integration'),
  f('aggregator.swiggy', 'M8 Omnichannel', GE, 'Swiggy integration'),
  f('aggregator.ondc', 'M8 Omnichannel', GE, 'ONDC integration'),
  f('kiosk', 'M8 Omnichannel', E, 'Self-order kiosk'),
  f('whatsapp_ordering', 'M8 Omnichannel', E, 'WhatsApp ordering'),
  f('delivery', 'M9 Delivery', G, 'Delivery module'),
  f('delivery.rider_tracking', 'M9 Delivery', G, 'Live rider tracking', ['delivery']),
  f('inventory.recipe_costing', 'M10 Inventory', G, 'Recipe costing and auto deduction'),
  f('inventory.batch_expiry', 'M10 Inventory', G, 'Batch / expiry tracking'),
  f('inventory.central_kitchen', 'M10 Inventory', G, 'Central kitchen transfers'),
  f('purchase', 'M11 Purchase', GE, 'Purchase and suppliers'),
  f('purchase.ocr', 'M11 Purchase', E, 'Invoice OCR', ['purchase']),
  f('crm', 'M12 CRM', G, 'Customer CRM'),
  f('loyalty', 'M12 CRM', G, 'Loyalty program', ['crm']),
  f('campaigns.whatsapp', 'M12 CRM', G, 'WhatsApp campaigns', ['crm']),
  f('hr.attendance', 'M13 HR', GE, 'Attendance and shifts'),
  f('hr.payroll', 'M13 HR', GE, 'Payroll', ['hr.attendance']),
  f('hr.biometric', 'M13 HR', E, 'Biometric attendance', ['hr.attendance']),
  f('accounting.tally', 'M14 Accounting', GE, 'Tally export'),
  f('accounting.zoho', 'M14 Accounting', GE, 'Zoho Books integration'),
  f('multi_outlet', 'M15 Multi-outlet', E, 'Multi-outlet management'),
  f('franchise', 'M15 Multi-outlet', E, 'Franchise management'),
  f('central_kitchen', 'M15 Multi-outlet', E, 'Central kitchen / commissary'),
  f('analytics.advanced', 'M16 Analytics', GE, 'Advanced analytics'),
  f('analytics.menu_engineering', 'M16 Analytics', GE, 'Menu engineering'),
  f('reports.scheduled', 'M16 Analytics', GE, 'Scheduled reports'),
  f('bi.export', 'M16 Analytics', E, 'BI export'),
  f('ai.forecasting', 'M17 AI', E, 'Demand forecasting'),
  f('ai.fraud', 'M17 AI', E, 'Fraud / anomaly detection'),
  f('ai.voice_ordering', 'M17 AI', E, 'Voice ordering'),
  f('ai.nl_reports', 'M17 AI', E, 'Natural-language reports'),
  f('api.public', 'M19 Developer', E, 'Public API'),
  f('webhooks', 'M19 Developer', E, 'Webhooks'),
  f('marketplace', 'M19 Developer', E, 'Integration marketplace'),
  f('whitelabel', 'M20 Customization', E, 'White-label'),
  f('custom_fields', 'M20 Customization', E, 'Custom fields'),
  f('rule_engine', 'M20 Customization', E, 'Rule engine'),
];

export interface PlanDef {
  code: PlanCode;
  name: string;
  priceMonthlyPaise: number;
  limits: { outlets: number; users: number; ordersPerMonth: number; storageMb: number };
}

export const PLANS: PlanDef[] = [
  { code: 'trial', name: 'Trial', priceMonthlyPaise: 0, limits: { outlets: 1, users: 5, ordersPerMonth: 1000, storageMb: 500 } },
  { code: 'starter', name: 'Starter', priceMonthlyPaise: 99900, limits: { outlets: 1, users: 10, ordersPerMonth: 5000, storageMb: 2000 } },
  { code: 'growth', name: 'Growth', priceMonthlyPaise: 249900, limits: { outlets: 3, users: 50, ordersPerMonth: 30000, storageMb: 10000 } },
  { code: 'enterprise', name: 'Enterprise', priceMonthlyPaise: 0, limits: { outlets: 1000, users: 5000, ordersPerMonth: 10_000_000, storageMb: 500_000 } },
];

export const TRIAL_DAYS = 14;
