-- Password reset tokens: single use, short lived, only a hash stored.
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('tenant','platform')),
  tenant_id uuid REFERENCES tenants(id),         -- NULL for platform users
  user_id uuid NOT NULL,                          -- users.id or platform_users.id
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets (kind, user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO rms_app;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON password_resets
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());
