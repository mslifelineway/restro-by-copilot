-- P0 completion: refresh-token sessions, device registration, idempotency keys.

-- ---------- Devices (POS / waiter / KDS tablets) ----------
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid REFERENCES outlets(id),
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android','ios','windows','web')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  registered_by uuid REFERENCES users(id),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1
);
CREATE TRIGGER devices_touch BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- Sessions (one row per refresh token; rotated on every refresh) ----------
-- family_id groups a rotation chain: presenting an already-rotated token revokes the whole family.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tenant','platform')),
  tenant_id uuid REFERENCES tenants(id),         -- NULL for platform sessions
  user_id uuid NOT NULL,                          -- users.id or platform_users.id
  device_id uuid REFERENCES devices(id),
  refresh_hash text NOT NULL,                     -- sha256 of the secret half of the token
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  replaced_by uuid,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX sessions_user ON sessions (kind, user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family ON sessions (family_id);

-- ---------- Idempotency keys ----------
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  actor_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON devices, sessions, idempotency_keys TO rms_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['devices','sessions','idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = app_tenant_id() OR app_is_platform())
      WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform())$p$, t);
  END LOOP;
END $$;
