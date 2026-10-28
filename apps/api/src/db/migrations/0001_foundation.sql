-- P0 foundation: multi-tenancy, identity/RBAC, plans, entitlements, subscription skeleton, audit.
-- Conventions: UUID PKs, money in integer paise, timestamps in UTC, soft delete via deleted_at,
-- tenant isolation via PostgreSQL RLS keyed on app.tenant_id / app.is_platform session settings.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('app.is_platform', true), '') = 'true' $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); NEW.version = OLD.version + 1; RETURN NEW; END $$;

-- ---------- Global (non-tenant) tables ----------
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  price_monthly_paise integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  limits jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE features (
  key text PRIMARY KEY,
  module text NOT NULL,
  type text NOT NULL CHECK (type IN ('entitlement','release','kill_switch')),
  description text NOT NULL DEFAULT '',
  depends_on text[] NOT NULL DEFAULT '{}',
  kill_switch boolean NOT NULL DEFAULT false, -- global kill overrides everything
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_features (
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES features(key) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin','support')),
  password_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Tenancy ----------
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','suspended','deleted')),
  plan_id uuid NOT NULL REFERENCES plans(id),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  currency text NOT NULL DEFAULT 'INR',
  language text NOT NULL DEFAULT 'en',
  date_format text NOT NULL DEFAULT 'DD/MM/YYYY',
  perm_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  code text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}',
  gstin text,
  timezone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  pin_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  permission text NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (role_id, permission)
);

-- outlet_id NULL = tenant-wide assignment
CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  outlet_id uuid REFERENCES outlets(id)
);
CREATE UNIQUE INDEX user_roles_uniq ON user_roles (user_id, role_id, COALESCE(outlet_id, '00000000-0000-0000-0000-000000000000'));

-- ---------- Entitlements ----------
CREATE TABLE tenant_features (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  feature_key text NOT NULL REFERENCES features(key),
  enabled boolean NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);

CREATE TABLE outlet_features (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL REFERENCES outlets(id),
  feature_key text NOT NULL REFERENCES features(key),
  enabled boolean NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outlet_id, feature_key)
);

-- append-only; tenant_id NULL for global changes (kill switch, plan matrix)
CREATE TABLE flag_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  outlet_id uuid,
  feature_key text NOT NULL,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  reason text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Subscription skeleton ----------
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  status text NOT NULL CHECK (status IN ('trialing','active','past_due','canceled')),
  billing_interval text NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly','yearly')),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz,
  external_ref text, -- Razorpay/Stripe subscription id (P2)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX subscriptions_one_live ON subscriptions (tenant_id) WHERE status <> 'canceled';

-- ---------- Audit (append-only) ----------
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('tenant_user','platform_user','system')),
  action text NOT NULL,
  entity text,
  entity_id text,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_time ON audit_log (tenant_id, created_at DESC);

-- ---------- updated_at / version triggers ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','outlets','users','roles','subscriptions'] LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------- Application role (subject to RLS) ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rms_app') THEN
    CREATE ROLE rms_app LOGIN PASSWORD 'rms_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO rms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rms_app;
-- append-only tables
REVOKE UPDATE, DELETE ON audit_log, flag_audit FROM rms_app;

-- ---------- Row-level security ----------
-- Tenant-scoped tables: visible/writable only when app.tenant_id matches, or in platform context.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['outlets','users','roles','role_permissions','user_roles',
                           'tenant_features','outlet_features','subscriptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = app_tenant_id() OR app_is_platform())
      WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform())$p$, t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_tenant_id() OR app_is_platform())
  WITH CHECK (id = app_tenant_id() OR app_is_platform());

-- Nullable tenant_id tables: tenant sees own rows only; platform sees all.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log','flag_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = app_tenant_id() OR app_is_platform())
      WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform() )$p$, t);
  END LOOP;
END $$;

-- Login must resolve a tenant by slug before a tenant context exists; the app does so in
-- platform context for that one lookup. platform_users has no tenant data and is only
-- queried from platform-context code paths.
