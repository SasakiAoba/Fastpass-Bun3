-- bun2fastpass / bun2fastpass-preview
-- Initial Cloudflare D1 schema. This migration creates no credential and
-- contains no plaintext password. Generate the first Argon2id hash through a
-- separate, non-public initialization procedure.

PRAGMA foreign_keys = ON;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  last_seen_at_ms INTEGER NOT NULL CHECK (last_seen_at_ms > 0),
  disabled_at_ms INTEGER
) STRICT;

CREATE TABLE auth_credentials (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  password_hash TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'argon2id'),
  memory_kib INTEGER NOT NULL CHECK (memory_kib >= 19456),
  iterations INTEGER NOT NULL CHECK (iterations >= 2),
  parallelism INTEGER NOT NULL CHECK (parallelism >= 1),
  auth_generation INTEGER NOT NULL CHECK (auth_generation >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('LIVE', 'DEV')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED', 'PURGING')),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  config_revision TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL CHECK (json_valid(config_snapshot_json)),
  ticket_prefix TEXT NOT NULL CHECK (length(ticket_prefix) BETWEEN 1 AND 16),
  unit_price_yen INTEGER NOT NULL CHECK (unit_price_yen > 0),
  max_ticket_number INTEGER NOT NULL CHECK (max_ticket_number > 0),
  max_items_per_operation INTEGER NOT NULL CHECK (max_items_per_operation > 0),
  max_tendered_yen INTEGER NOT NULL CHECK (max_tendered_yen > 0),
  last_ticket_number INTEGER NOT NULL DEFAULT 0 CHECK (last_ticket_number >= 0),
  last_group_number INTEGER NOT NULL DEFAULT 0 CHECK (last_group_number >= 0),
  selected_test_day INTEGER NOT NULL DEFAULT 1 CHECK (selected_test_day IN (1, 2, 3)),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms > 0),
  ended_at_ms INTEGER,
  UNIQUE (kind, sequence),
  CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)
) STRICT;

CREATE TABLE business_days (
  workspace_id TEXT NOT NULL,
  day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)),
  event_date TEXT,
  ticket_limit INTEGER NOT NULL CHECK (ticket_limit >= 0),
  sold_count INTEGER NOT NULL DEFAULT 0 CHECK (sold_count >= 0),
  PRIMARY KEY (workspace_id, day_number),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CHECK (event_date IS NULL OR event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) STRICT;

CREATE TABLE cashboxes (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE system_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('LIVE', 'ENTERING_DEV', 'DEVELOPMENT', 'PURGING_DEV')),
  mode_epoch INTEGER NOT NULL CHECK (mode_epoch >= 1),
  maintenance INTEGER NOT NULL CHECK (maintenance IN (0, 1)),
  current_live_workspace_id TEXT NOT NULL,
  current_dev_workspace_id TEXT,
  auth_generation INTEGER NOT NULL CHECK (auth_generation >= 1),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
  FOREIGN KEY (current_live_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (current_dev_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  CHECK (
    (mode = 'LIVE' AND current_dev_workspace_id IS NULL) OR
    (mode <> 'LIVE' AND current_dev_workspace_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  auth_generation INTEGER NOT NULL CHECK (auth_generation >= 1),
  confirmed_mode_epoch INTEGER NOT NULL CHECK (confirmed_mode_epoch >= 1),
  confirmed_workspace_id TEXT,
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms > 0),
  last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= issued_at_ms),
  idle_expires_at_ms INTEGER NOT NULL CHECK (idle_expires_at_ms > last_used_at_ms),
  absolute_expires_at_ms INTEGER NOT NULL CHECK (absolute_expires_at_ms >= idle_expires_at_ms),
  revoked_at_ms INTEGER,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (confirmed_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE auth_attempts (
  id TEXT PRIMARY KEY,
  scope_key_hash TEXT NOT NULL,
  device_id TEXT,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  attempted_at_ms INTEGER NOT NULL CHECK (attempted_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > attempted_at_ms),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE reauth_grants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  workspace_id TEXT,
  mode_epoch INTEGER NOT NULL CHECK (mode_epoch >= 1),
  control_operation_id TEXT,
  issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
  used_at_ms INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (control_operation_id) REFERENCES control_operations(id) ON DELETE CASCADE,
  CHECK (used_at_ms IS NULL OR used_at_ms >= issued_at_ms)
) STRICT;

CREATE TABLE control_operations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  target_workspace_id TEXT,
  expected_mode_epoch INTEGER NOT NULL CHECK (expected_mode_epoch >= 1),
  checkpoint TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  completed_at_ms INTEGER,
  FOREIGN KEY (target_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE system_audit_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  device_id TEXT,
  session_id TEXT,
  operation_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'REJECTED', 'UNKNOWN')),
  detail TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE checkouts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_yen INTEGER NOT NULL CHECK (unit_price_yen > 0),
  status TEXT NOT NULL CHECK (status IN ('HELD', 'CANCELLED', 'EXPIRED', 'COMPLETED')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  device_id TEXT NOT NULL,
  cashbox_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, request_id),
  FOREIGN KEY (workspace_id, day_number) REFERENCES business_days(workspace_id, day_number) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, cashbox_id) REFERENCES cashboxes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE sales (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  group_number INTEGER NOT NULL CHECK (group_number >= 1),
  day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_yen INTEGER NOT NULL CHECK (unit_price_yen > 0),
  total_yen INTEGER NOT NULL CHECK (total_yen > 0),
  tendered_yen INTEGER NOT NULL CHECK (tendered_yen >= total_yen),
  change_yen INTEGER NOT NULL CHECK (change_yen >= 0),
  purchased_at_ms INTEGER NOT NULL CHECK (purchased_at_ms > 0),
  device_id TEXT NOT NULL,
  cashbox_id TEXT NOT NULL,
  handover_confirmed_at_ms INTEGER,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, checkout_id),
  UNIQUE (workspace_id, group_number),
  FOREIGN KEY (workspace_id, checkout_id) REFERENCES checkouts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, day_number) REFERENCES business_days(workspace_id, day_number) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, cashbox_id) REFERENCES cashboxes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (total_yen = unit_price_yen * quantity),
  CHECK (change_yen = tendered_yen - total_yen),
  CHECK (handover_confirmed_at_ms IS NULL OR handover_confirmed_at_ms >= purchased_at_ms)
) STRICT;

CREATE TABLE tickets (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  serial_number INTEGER NOT NULL CHECK (serial_number >= 1),
  sale_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ISSUED', 'USED', 'REFUNDED')),
  used_at_ms INTEGER,
  current_use_event_id TEXT,
  refunded_at_ms INTEGER,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, serial_number),
  FOREIGN KEY (workspace_id, sale_id) REFERENCES sales(workspace_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'ISSUED' AND used_at_ms IS NULL AND current_use_event_id IS NULL AND refunded_at_ms IS NULL) OR
    (status = 'USED' AND used_at_ms IS NOT NULL AND current_use_event_id IS NOT NULL AND refunded_at_ms IS NULL) OR
    (status = 'REFUNDED' AND used_at_ms IS NULL AND current_use_event_id IS NULL AND refunded_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE ticket_events (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SALE', 'CHECKIN', 'CHECKIN_REVERSAL', 'REFUND')),
  from_status TEXT NOT NULL CHECK (from_status IN ('UNISSUED', 'ISSUED', 'USED', 'REFUNDED')),
  to_status TEXT NOT NULL CHECK (to_status IN ('ISSUED', 'USED', 'REFUNDED')),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  reason TEXT,
  reversed_event_id TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE refunds (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  total_yen INTEGER NOT NULL CHECK (total_yen > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
  device_id TEXT NOT NULL,
  cashbox_id TEXT NOT NULL,
  handover_confirmed_at_ms INTEGER,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, cashbox_id) REFERENCES cashboxes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (handover_confirmed_at_ms IS NULL OR handover_confirmed_at_ms >= occurred_at_ms)
) STRICT;

CREATE TABLE refund_items (
  workspace_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  refund_yen INTEGER NOT NULL CHECK (refund_yen > 0),
  PRIMARY KEY (workspace_id, refund_id, ticket_id),
  UNIQUE (workspace_id, ticket_id),
  FOREIGN KEY (workspace_id, refund_id) REFERENCES refunds(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, sale_id) REFERENCES sales(workspace_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE cash_ledger (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  cashbox_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('OPENING_FLOAT', 'SALE', 'REFUND', 'TOP_UP', 'COLLECTION', 'EXPENSE', 'REVERSAL')),
  amount_yen INTEGER NOT NULL CHECK (amount_yen <> 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
  day_number INTEGER CHECK (day_number IN (1, 2, 3)),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT,
  reversed_entry_id TEXT,
  device_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, source_type, source_id),
  FOREIGN KEY (workspace_id, cashbox_id) REFERENCES cashboxes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, reversed_entry_id) REFERENCES cash_ledger(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE expenses (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  amount_yen INTEGER NOT NULL CHECK (amount_yen > 0),
  category TEXT NOT NULL CHECK (length(trim(category)) > 0),
  payment_source TEXT NOT NULL CHECK (payment_source IN ('CASHBOX', 'OUTSIDE')),
  day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  ledger_entry_id TEXT,
  cancelled_at_ms INTEGER,
  cancellation_reason TEXT,
  cancel_operation_id TEXT,
  device_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, day_number) REFERENCES business_days(workspace_id, day_number) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, ledger_entry_id) REFERENCES cash_ledger(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (cancelled_at_ms IS NULL OR cancelled_at_ms >= occurred_at_ms)
) STRICT;

CREATE TABLE cash_counts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  cashbox_id TEXT NOT NULL,
  actual_yen INTEGER NOT NULL CHECK (actual_yen >= 0),
  expected_yen INTEGER NOT NULL,
  difference_yen INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
  device_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, cashbox_id) REFERENCES cashboxes(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (difference_yen = actual_yen - expected_yen)
) STRICT;

CREATE TABLE accounting_settings (
  workspace_id TEXT PRIMARY KEY,
  expenses_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (expenses_confirmed IN (0, 1)),
  expenses_confirmed_at_ms INTEGER,
  expenses_confirmed_by_device_id TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (expenses_confirmed_by_device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  CHECK (
    (expenses_confirmed = 0 AND expenses_confirmed_at_ms IS NULL) OR
    (expenses_confirmed = 1 AND expenses_confirmed_at_ms IS NOT NULL)
  )
) STRICT;

CREATE TABLE business_operations (
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms > 0),
  PRIMARY KEY (workspace_id, request_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE business_audit_logs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'REJECTED', 'UNKNOWN')),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0),
  device_id TEXT,
  operation_id TEXT,
  detail TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE transaction_assertions (
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  assertion_key TEXT NOT NULL,
  assertion_value INTEGER NOT NULL CHECK (assertion_value = 1),
  PRIMARY KEY (workspace_id, operation_id, assertion_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_sessions_expiry ON sessions(revoked_at_ms, idle_expires_at_ms, absolute_expires_at_ms);
CREATE INDEX idx_auth_attempts_scope_time ON auth_attempts(scope_key_hash, attempted_at_ms DESC);
CREATE INDEX idx_auth_attempts_expiry ON auth_attempts(expires_at_ms);
CREATE INDEX idx_reauth_grants_lookup ON reauth_grants(session_id, purpose, workspace_id, mode_epoch, expires_at_ms, used_at_ms);
CREATE INDEX idx_control_operations_target ON control_operations(target_workspace_id, status, updated_at_ms);
CREATE INDEX idx_system_audit_time ON system_audit_logs(occurred_at_ms DESC);
CREATE INDEX idx_checkouts_active ON checkouts(workspace_id, status, expires_at_ms);
CREATE INDEX idx_sales_day_time ON sales(workspace_id, day_number, purchased_at_ms DESC);
CREATE INDEX idx_tickets_status ON tickets(workspace_id, status, serial_number);
CREATE INDEX idx_ticket_events_ticket_time ON ticket_events(workspace_id, ticket_id, occurred_at_ms DESC);
CREATE INDEX idx_ticket_events_operation ON ticket_events(workspace_id, operation_id);
CREATE INDEX idx_refunds_time ON refunds(workspace_id, occurred_at_ms DESC);
CREATE INDEX idx_cash_ledger_time ON cash_ledger(workspace_id, occurred_at_ms DESC);
CREATE INDEX idx_expenses_active ON expenses(workspace_id, cancelled_at_ms, occurred_at_ms DESC);
CREATE INDEX idx_cash_counts_time ON cash_counts(workspace_id, occurred_at_ms DESC);
CREATE INDEX idx_business_audit_time ON business_audit_logs(workspace_id, occurred_at_ms DESC);
CREATE INDEX idx_business_audit_operation ON business_audit_logs(workspace_id, operation_id);

CREATE TRIGGER trg_live_ticket_number_limit
BEFORE INSERT ON tickets
WHEN (
  SELECT kind = 'LIVE' AND NEW.serial_number > max_ticket_number
  FROM workspaces
  WHERE id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'LIVE_TICKET_NUMBER_LIMIT');
END;

CREATE TRIGGER trg_live_day_limit_insert
BEFORE INSERT ON business_days
WHEN (
  SELECT kind = 'LIVE' AND NEW.sold_count > NEW.ticket_limit
  FROM workspaces
  WHERE id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'LIVE_DAILY_TICKET_LIMIT');
END;

CREATE TRIGGER trg_live_day_limit_update
BEFORE UPDATE OF sold_count, ticket_limit ON business_days
WHEN (
  SELECT kind = 'LIVE' AND NEW.sold_count > NEW.ticket_limit
  FROM workspaces
  WHERE id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'LIVE_DAILY_TICKET_LIMIT');
END;

CREATE VIEW v_ticket_records AS
SELECT
  t.workspace_id,
  t.id AS ticket_id,
  t.serial_number,
  t.status,
  t.used_at_ms,
  t.refunded_at_ms,
  t.version,
  s.id AS sale_id,
  s.group_number,
  s.day_number,
  s.unit_price_yen,
  s.purchased_at_ms,
  s.handover_confirmed_at_ms
FROM tickets AS t
JOIN sales AS s
  ON s.workspace_id = t.workspace_id
 AND s.id = t.sale_id;

CREATE VIEW v_workspace_accounting AS
WITH
sale_totals AS (
  SELECT workspace_id, COALESCE(SUM(total_yen), 0) AS gross_sales_yen
  FROM sales
  GROUP BY workspace_id
),
refund_totals AS (
  SELECT workspace_id, COALESCE(SUM(total_yen), 0) AS refunds_yen
  FROM refunds
  GROUP BY workspace_id
),
expense_totals AS (
  SELECT workspace_id, COALESCE(SUM(amount_yen), 0) AS expenses_yen
  FROM expenses
  WHERE cancelled_at_ms IS NULL
  GROUP BY workspace_id
),
cash_totals AS (
  SELECT workspace_id, COALESCE(SUM(amount_yen), 0) AS expected_cash_yen
  FROM cash_ledger
  GROUP BY workspace_id
)
SELECT
  w.id AS workspace_id,
  COALESCE(s.gross_sales_yen, 0) AS gross_sales_yen,
  COALESCE(r.refunds_yen, 0) AS refunds_yen,
  COALESCE(s.gross_sales_yen, 0) - COALESCE(r.refunds_yen, 0) AS net_sales_yen,
  COALESCE(e.expenses_yen, 0) AS expenses_yen,
  COALESCE(c.expected_cash_yen, 0) AS expected_cash_yen
FROM workspaces AS w
LEFT JOIN sale_totals AS s ON s.workspace_id = w.id
LEFT JOIN refund_totals AS r ON r.workspace_id = w.id
LEFT JOIN expense_totals AS e ON e.workspace_id = w.id
LEFT JOIN cash_totals AS c ON c.workspace_id = w.id;
