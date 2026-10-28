import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Load repo-root .env when present, without overriding variables supplied by the process.
const envFile = [
  resolve(__dirname, '../../../.env'),
  resolve(process.cwd(), '../../.env'),
].find(existsSync);
if (envFile) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required env var ${name}`);
  return devDefault;
}

if (isProd && process.env.MAIL_TRANSPORT === 'smtp' && !process.env.SMTP_URL) throw new Error('MAIL_TRANSPORT=smtp requires SMTP_URL');

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 3100),
  databaseUrl: required('DATABASE_URL', 'postgres://rms_app:rms_app@localhost:5440/rms'),
  databaseOwnerUrl: required('DATABASE_OWNER_URL', 'postgres://rms:rms@localhost:5440/rms'),
  appDbPassword: process.env.RMS_APP_DB_PASSWORD ?? 'rms_app',
  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),
  jwtAccessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
  /** A just-rotated refresh token may be presented again within this window (parallel requests / retries) without triggering theft detection. */
  refreshReuseLeewaySeconds: Number(process.env.REFRESH_REUSE_LEEWAY_SECONDS ?? 10),
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS ?? 7),
  /** Express `trust proxy` value so rate limiting sees the real client IP (BFF forwards x-forwarded-for). */
  trustProxy: process.env.TRUST_PROXY ?? 'loopback',
  throttleDefaultPerMin: Number(process.env.THROTTLE_DEFAULT_PER_MIN ?? 300),
  throttleAuthPerMin: Number(process.env.THROTTLE_AUTH_PER_MIN ?? 10),
  platformAdminEmail: process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@rms.local',
  platformAdminPassword: process.env.PLATFORM_ADMIN_PASSWORD ?? 'ChangeMe123!',
  /** Public URL of the admin app; used to build links in emails. */
  adminUrl: process.env.ADMIN_URL ?? 'http://localhost:3001',
  /** 'console' logs emails and keeps them in memory (dev/test only); 'smtp' sends via SMTP_URL. Must be explicit in production. */
  mailTransport: required('MAIL_TRANSPORT', 'console') as 'console' | 'smtp',
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'RMS <no-reply@rms.local>',
  resetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30),
  /** Reset emails per account per hour; extra requests are silently ignored (anti-spam, no enumeration). */
  resetMaxPerHour: Number(process.env.PASSWORD_RESET_MAX_PER_HOUR ?? 3),
  maxFailedAttempts: 5,
  lockMinutes: 15,
};
