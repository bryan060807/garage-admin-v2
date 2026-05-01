CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'medium',
  summary TEXT NOT NULL DEFAULT '',
  service_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS incidents_created_at_idx
  ON incidents (created_at DESC);

CREATE INDEX IF NOT EXISTS incidents_status_idx
  ON incidents (status, severity);

CREATE TABLE IF NOT EXISTS service_facts (
  id UUID PRIMARY KEY,
  service_name TEXT NOT NULL,
  fact_type TEXT NOT NULL DEFAULT 'note',
  fact_key TEXT NOT NULL,
  fact_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_name, fact_key)
);

CREATE INDEX IF NOT EXISTS service_facts_service_name_idx
  ON service_facts (service_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS action_audit (
  id UUID PRIMARY KEY,
  action_type TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL DEFAULT 'system',
  approved_by TEXT,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_audit_created_at_idx
  ON action_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS action_audit_status_idx
  ON action_audit (status, created_at DESC);
