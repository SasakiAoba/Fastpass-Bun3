-- Adds transaction assertions used by Pages Functions to make conditional,
-- multi-row business operations fail atomically when concurrent state changed.

CREATE TABLE transaction_assertions (
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  assertion_key TEXT NOT NULL CHECK (length(trim(assertion_key)) > 0),
  expected_count INTEGER NOT NULL CHECK (expected_count >= 0),
  actual_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  PRIMARY KEY (workspace_id, request_id, assertion_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CHECK (actual_count = expected_count)
) STRICT;

CREATE INDEX idx_transaction_assertions_time
  ON transaction_assertions(workspace_id, created_at_ms DESC);

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (2, '0002_atomic_operations', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

PRAGMA optimize;
