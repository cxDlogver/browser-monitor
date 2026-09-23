CREATE TABLE lab_audit_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  headers_ciphertext bytea,
  headers_iv bytea,
  headers_auth_tag bytea,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((headers_ciphertext IS NULL AND headers_iv IS NULL AND headers_auth_tag IS NULL) OR (headers_ciphertext IS NOT NULL AND headers_iv IS NOT NULL AND headers_auth_tag IS NOT NULL))
);

CREATE TABLE lab_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  target_url text NOT NULL,
  device varchar(16) NOT NULL CHECK (device IN ('mobile', 'desktop')),
  status varchar(16) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_runs integer NOT NULL DEFAULT 5 CHECK (requested_runs BETWEEN 1 AND 9),
  completed_runs integer NOT NULL DEFAULT 0 CHECK (completed_runs >= 0),
  successful_runs integer NOT NULL DEFAULT 0 CHECK (successful_runs >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lighthouse_version varchar(64),
  chrome_version varchar(128),
  environment jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb,
  analysis jsonb,
  warning text,
  last_error text,
  locked_by varchar(128),
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX lab_audits_one_active_project_idx ON lab_audits(project_id) WHERE status IN ('queued', 'running');
CREATE INDEX lab_audits_project_created_idx ON lab_audits(project_id, created_at DESC);
CREATE INDEX lab_audits_claim_idx ON lab_audits(status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE lab_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id uuid NOT NULL REFERENCES lab_audits(id) ON DELETE CASCADE,
  run_number integer NOT NULL CHECK (run_number > 0),
  status varchar(16) NOT NULL CHECK (status IN ('completed', 'failed')),
  scores jsonb,
  metrics jsonb,
  diagnostics jsonb,
  error text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (audit_id, run_number)
);

CREATE INDEX lab_audit_runs_audit_idx ON lab_audit_runs(audit_id, run_number);
