-- Retain only operation identity, never deleted test ticket/sale contents.
-- Allows an offline device to distinguish a purged DEV operation from a
-- mutation whose result is still unknown.
CREATE TABLE purged_operation_receipts (
  request_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  purged_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_business_operations_request_lookup ON business_operations(request_id, committed_at_ms DESC);

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (4, 'purged_operation_receipts', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
