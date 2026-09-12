-- bun2fastpass / bun2fastpass-preview
-- Production-compatible baseline. No credential or localStorage data is inserted.

CREATE TABLE schema_migrations ( version INTEGER PRIMARY KEY CHECK (version >= 1), name TEXT NOT NULL UNIQUE, applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms > 0) ) STRICT;

CREATE TABLE devices ( id TEXT PRIMARY KEY, display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100), created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0), last_seen_at_ms INTEGER NOT NULL CHECK (last_seen_at_ms >= created_at_ms), disabled_at_ms INTEGER, CHECK (disabled_at_ms IS NULL OR disabled_at_ms >= created_at_ms) ) STRICT;

CREATE TABLE auth_credentials ( singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), password_hash TEXT NOT NULL, algorithm TEXT NOT NULL CHECK (algorithm = 'argon2id'), memory_kib INTEGER NOT NULL CHECK (memory_kib >= 19456), iterations INTEGER NOT NULL CHECK (iterations >= 2), parallelism INTEGER NOT NULL CHECK (parallelism >= 1), auth_generation INTEGER NOT NULL CHECK (auth_generation >= 1), created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0), updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms) ) STRICT;

CREATE TABLE workspaces ( id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('LIVE', 'DEV')), status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED', 'PURGING')), sequence INTEGER NOT NULL CHECK (sequence >= 1), config_revision TEXT NOT NULL CHECK (length(trim(config_revision)) > 0), config_snapshot_json TEXT NOT NULL CHECK (json_valid(config_snapshot_json)), ticket_prefix TEXT NOT NULL CHECK (length(ticket_prefix) BETWEEN 1 AND 16), unit_price_yen INTEGER NOT NULL CHECK (unit_price_yen > 0), max_ticket_number INTEGER NOT NULL CHECK (max_ticket_number > 0), max_items_per_operation INTEGER NOT NULL CHECK (max_items_per_operation > 0), max_tendered_yen INTEGER NOT NULL CHECK (max_tendered_yen > 0), checkout_hold_seconds INTEGER NOT NULL CHECK (checkout_hold_seconds > 0), last_ticket_number INTEGER NOT NULL DEFAULT 0 CHECK (last_ticket_number >= 0), last_group_number INTEGER NOT NULL DEFAULT 0 CHECK (last_group_number >= 0), selected_test_day INTEGER NOT NULL DEFAULT 1 CHECK (selected_test_day IN (1, 2, 3)), started_at_ms INTEGER NOT NULL CHECK (started_at_ms > 0), ended_at_ms INTEGER, UNIQUE (kind, sequence), CHECK (last_ticket_number <= max_ticket_number OR kind = 'DEV'), CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms) ) STRICT;

CREATE UNIQUE INDEX idx_workspaces_one_active_kind ON workspaces(kind) WHERE status = 'ACTIVE';

CREATE TABLE business_days ( workspace_id TEXT NOT NULL, day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)), event_date TEXT, ticket_limit INTEGER NOT NULL CHECK (ticket_limit >= 0), sold_count INTEGER NOT NULL DEFAULT 0 CHECK (sold_count >= 0), PRIMARY KEY (workspace_id, day_number), FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE, CHECK ( event_date IS NULL OR event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' ) ) STRICT;

CREATE UNIQUE INDEX idx_business_days_event_date ON business_days(workspace_id, event_date) WHERE event_date IS NOT NULL;

CREATE TABLE system_state ( singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), mode TEXT NOT NULL CHECK ( mode IN ('LIVE', 'ENTERING_DEV', 'DEVELOPMENT', 'PURGING_DEV') ), mode_epoch INTEGER NOT NULL CHECK (mode_epoch >= 1), maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)), current_live_workspace_id TEXT NOT NULL, current_dev_workspace_id TEXT, updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0), FOREIGN KEY (current_live_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT, FOREIGN KEY (current_dev_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL, CHECK ( (mode = 'LIVE' AND current_dev_workspace_id IS NULL) OR (mode <> 'LIVE' AND current_dev_workspace_id IS NOT NULL) ) ) STRICT;

CREATE TABLE sessions ( id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token_hash TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, auth_generation INTEGER NOT NULL CHECK (auth_generation >= 1), issued_at_ms INTEGER NOT NULL CHECK (issued_at_ms > 0), last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= issued_at_ms), revoked_at_ms INTEGER, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT, CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= issued_at_ms) ) STRICT;

CREATE TABLE login_attempts ( id TEXT PRIMARY KEY, scope_key_hash TEXT NOT NULL, device_id TEXT, succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)), attempted_at_ms INTEGER NOT NULL CHECK (attempted_at_ms > 0), expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > attempted_at_ms), FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL ) STRICT;

CREATE TABLE business_operations ( workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, type TEXT NOT NULL CHECK (length(trim(type)) > 0), request_hash TEXT NOT NULL CHECK (length(request_hash) >= 32), result_json TEXT NOT NULL CHECK (json_valid(result_json)), committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms > 0), PRIMARY KEY (workspace_id, request_id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE ) STRICT;

CREATE TABLE checkouts ( workspace_id TEXT NOT NULL, id TEXT NOT NULL, request_id TEXT NOT NULL, day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)), quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price_yen INTEGER NOT NULL CHECK (unit_price_yen > 0), status TEXT NOT NULL CHECK ( status IN ('HELD', 'CANCELLED', 'EXPIRED', 'COMPLETED') ), created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0), expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms), device_id TEXT NOT NULL, PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, request_id), FOREIGN KEY (workspace_id, day_number) REFERENCES business_days(workspace_id, day_number) ON DELETE CASCADE, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT ) STRICT;

CREATE TABLE sales ( workspace_id TEXT NOT NULL, id TEXT NOT NULL, checkout_id TEXT NOT NULL, group_number INTEGER NOT NULL CHECK (group_number >= 1), day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)), quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price_yen INTEGER NOT NULL CHECK (unit_price_yen > 0), total_yen INTEGER NOT NULL CHECK (total_yen > 0), tendered_yen INTEGER NOT NULL CHECK (tendered_yen >= total_yen), change_yen INTEGER NOT NULL CHECK (change_yen >= 0), purchased_at_ms INTEGER NOT NULL CHECK (purchased_at_ms > 0), device_id TEXT NOT NULL, handover_confirmed_at_ms INTEGER, PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, checkout_id), UNIQUE (workspace_id, group_number), FOREIGN KEY (workspace_id, checkout_id) REFERENCES checkouts(workspace_id, id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, day_number) REFERENCES business_days(workspace_id, day_number) ON DELETE CASCADE, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT, CHECK (total_yen = unit_price_yen * quantity), CHECK (change_yen = tendered_yen - total_yen), CHECK ( handover_confirmed_at_ms IS NULL OR handover_confirmed_at_ms >= purchased_at_ms ) ) STRICT;

CREATE TABLE tickets ( workspace_id TEXT NOT NULL, id TEXT NOT NULL, serial_number INTEGER NOT NULL CHECK (serial_number >= 1), sale_id TEXT NOT NULL, status TEXT NOT NULL CHECK ( status IN ('ISSUED', 'USED', 'REFUNDED') ), used_at_ms INTEGER, current_use_event_id TEXT, refunded_at_ms INTEGER, version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0), PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, serial_number), UNIQUE (workspace_id, id, sale_id), FOREIGN KEY (workspace_id, sale_id) REFERENCES sales(workspace_id, id) ON DELETE CASCADE, CHECK ( ( status = 'ISSUED' AND used_at_ms IS NULL AND current_use_event_id IS NULL AND refunded_at_ms IS NULL ) OR ( status = 'USED' AND used_at_ms IS NOT NULL AND current_use_event_id IS NOT NULL AND refunded_at_ms IS NULL ) OR ( status = 'REFUNDED' AND used_at_ms IS NULL AND current_use_event_id IS NULL AND refunded_at_ms IS NOT NULL ) ) ) STRICT;

CREATE TABLE ticket_events ( workspace_id TEXT NOT NULL, id TEXT NOT NULL, ticket_id TEXT NOT NULL, type TEXT NOT NULL CHECK ( type IN ('SALE', 'CHECKIN', 'CHECKIN_REVERSAL', 'REFUND') ), from_status TEXT NOT NULL CHECK ( from_status IN ('UNISSUED', 'ISSUED', 'USED', 'REFUNDED') ), to_status TEXT NOT NULL CHECK ( to_status IN ('ISSUED', 'USED', 'REFUNDED') ), occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0), device_id TEXT NOT NULL, operation_id TEXT NOT NULL, reason TEXT, reversed_event_id TEXT, PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, id, ticket_id), FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets(workspace_id, id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, reversed_event_id, ticket_id) REFERENCES ticket_events(workspace_id, id, ticket_id) ON DELETE CASCADE, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT ) STRICT;

CREATE TABLE admissions ( workspace_id TEXT NOT NULL, id TEXT NOT NULL, operation_id TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0), device_id TEXT NOT NULL, PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, operation_id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT ) STRICT;

CREATE TABLE admission_items ( workspace_id TEXT NOT NULL, admission_id TEXT NOT NULL, ticket_id TEXT NOT NULL, PRIMARY KEY (workspace_id, admission_id, ticket_id), UNIQUE (workspace_id, ticket_id, admission_id), FOREIGN KEY (workspace_id, admission_id) REFERENCES admissions(workspace_id, id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets(workspace_id, id) ON DELETE CASCADE ) STRICT;

CREATE TABLE checkin_reversals ( workspace_id TEXT NOT NULL, id TEXT NOT NULL, ticket_id TEXT NOT NULL, use_event_id TEXT NOT NULL, reason TEXT NOT NULL CHECK (length(trim(reason)) > 0), operation_id TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0), device_id TEXT NOT NULL, PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, use_event_id), UNIQUE (workspace_id, operation_id), FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets(workspace_id, id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, use_event_id, ticket_id) REFERENCES ticket_events(workspace_id, id, ticket_id) ON DELETE CASCADE, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT ) STRICT;

CREATE TABLE refunds ( workspace_id TEXT NOT NULL, id TEXT NOT NULL, operation_id TEXT NOT NULL, day_number INTEGER NOT NULL CHECK (day_number IN (1, 2, 3)), total_yen INTEGER NOT NULL CHECK (total_yen > 0), reason TEXT NOT NULL CHECK (length(trim(reason)) > 0), occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0), device_id TEXT NOT NULL, handover_confirmed_at_ms INTEGER, PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, operation_id), FOREIGN KEY (workspace_id, day_number) REFERENCES business_days(workspace_id, day_number) ON DELETE CASCADE, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT, CHECK ( handover_confirmed_at_ms IS NULL OR handover_confirmed_at_ms >= occurred_at_ms ) ) STRICT;

CREATE TABLE refund_items ( workspace_id TEXT NOT NULL, refund_id TEXT NOT NULL, ticket_id TEXT NOT NULL, sale_id TEXT NOT NULL, refund_yen INTEGER NOT NULL CHECK (refund_yen > 0), PRIMARY KEY (workspace_id, refund_id, ticket_id), UNIQUE (workspace_id, ticket_id), FOREIGN KEY (workspace_id, refund_id) REFERENCES refunds(workspace_id, id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, ticket_id, sale_id) REFERENCES tickets(workspace_id, id, sale_id) ON DELETE CASCADE ) STRICT;

CREATE TABLE audit_logs ( id TEXT PRIMARY KEY, workspace_id TEXT, device_id TEXT, session_id TEXT, operation_id TEXT, type TEXT NOT NULL CHECK (length(trim(type)) > 0), status TEXT NOT NULL CHECK ( status IN ('SUCCESS', 'REJECTED', 'UNKNOWN') ), detail TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms > 0), FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE, FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL, FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL ) STRICT;

CREATE INDEX idx_sessions_active ON sessions(token_hash, auth_generation) WHERE revoked_at_ms IS NULL;

CREATE INDEX idx_login_attempts_scope_time ON login_attempts(scope_key_hash, attempted_at_ms DESC);

CREATE INDEX idx_login_attempts_expiry ON login_attempts(expires_at_ms);

CREATE INDEX idx_business_operations_time ON business_operations(workspace_id, committed_at_ms DESC);

CREATE INDEX idx_checkouts_active ON checkouts(workspace_id, day_number, status, expires_at_ms);

CREATE INDEX idx_sales_day_time ON sales(workspace_id, day_number, purchased_at_ms DESC);

CREATE INDEX idx_tickets_status ON tickets(workspace_id, status, serial_number);

CREATE INDEX idx_ticket_events_ticket_time ON ticket_events(workspace_id, ticket_id, occurred_at_ms DESC);

CREATE INDEX idx_ticket_events_operation ON ticket_events(workspace_id, operation_id);

CREATE INDEX idx_admissions_time ON admissions(workspace_id, occurred_at_ms DESC);

CREATE INDEX idx_refunds_day_time ON refunds(workspace_id, day_number, occurred_at_ms DESC);

CREATE INDEX idx_audit_logs_time ON audit_logs(workspace_id, occurred_at_ms DESC);

CREATE INDEX idx_audit_logs_operation ON audit_logs(workspace_id, operation_id);

CREATE TRIGGER trg_live_ticket_number_limit BEFORE INSERT ON tickets WHEN EXISTS ( SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND kind = 'LIVE' AND NEW.serial_number > max_ticket_number ) BEGIN SELECT RAISE(ABORT, 'LIVE_TICKET_NUMBER_LIMIT');

END;

CREATE TRIGGER trg_live_day_limit_insert BEFORE INSERT ON business_days WHEN EXISTS ( SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND kind = 'LIVE' AND NEW.sold_count > NEW.ticket_limit ) BEGIN SELECT RAISE(ABORT, 'LIVE_DAILY_TICKET_LIMIT');

END;

CREATE TRIGGER trg_live_day_limit_update BEFORE UPDATE OF sold_count, ticket_limit ON business_days WHEN EXISTS ( SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND kind = 'LIVE' AND NEW.sold_count > NEW.ticket_limit ) BEGIN SELECT RAISE(ABORT, 'LIVE_DAILY_TICKET_LIMIT');

END;

CREATE VIEW v_ticket_records AS SELECT t.workspace_id, t.id AS ticket_id, t.serial_number, t.status, t.used_at_ms, t.refunded_at_ms, t.version, s.id AS sale_id, s.group_number, s.day_number, s.unit_price_yen, s.purchased_at_ms, s.handover_confirmed_at_ms FROM tickets AS t JOIN sales AS s ON s.workspace_id = t.workspace_id AND s.id = t.sale_id;

CREATE VIEW v_workspace_accounting AS WITH sale_totals AS ( SELECT workspace_id, COUNT(*) AS checkout_count, COALESCE(SUM(quantity), 0) AS sold_count, COALESCE(SUM(tendered_yen), 0) AS total_tendered_yen, COALESCE(SUM(change_yen), 0) AS total_change_yen FROM sales GROUP BY workspace_id ), refund_totals AS ( SELECT r.workspace_id, COUNT(ri.ticket_id) AS refunded_count, COALESCE(SUM(ri.refund_yen), 0) AS refunds_yen FROM refunds AS r JOIN refund_items AS ri ON ri.workspace_id = r.workspace_id AND ri.refund_id = r.id GROUP BY r.workspace_id ) SELECT w.id AS workspace_id, COALESCE(s.checkout_count, 0) AS checkout_count, COALESCE(s.sold_count, 0) AS sold_count, COALESCE(s.total_tendered_yen, 0) AS total_tendered_yen, COALESCE(s.total_change_yen, 0) AS total_change_yen, COALESCE(s.total_tendered_yen, 0) - COALESCE(s.total_change_yen, 0) AS final_profit_yen, COALESCE(r.refunded_count, 0) AS refunded_count, COALESCE(r.refunds_yen, 0) AS refunds_yen, COALESCE(s.total_tendered_yen, 0) - COALESCE(s.total_change_yen, 0) - COALESCE(r.refunds_yen, 0) AS after_refund_yen FROM workspaces AS w LEFT JOIN sale_totals AS s ON s.workspace_id = w.id LEFT JOIN refund_totals AS r ON r.workspace_id = w.id;

CREATE VIEW v_daily_accounting AS WITH sale_totals AS ( SELECT workspace_id, day_number, COUNT(*) AS checkout_count, COALESCE(SUM(quantity), 0) AS sold_count, COALESCE(SUM(tendered_yen), 0) AS total_tendered_yen, COALESCE(SUM(change_yen), 0) AS total_change_yen FROM sales GROUP BY workspace_id, day_number ), refund_totals AS ( SELECT r.workspace_id, r.day_number, COUNT(ri.ticket_id) AS refunded_count, COALESCE(SUM(ri.refund_yen), 0) AS refunds_yen FROM refunds AS r JOIN refund_items AS ri ON ri.workspace_id = r.workspace_id AND ri.refund_id = r.id GROUP BY r.workspace_id, r.day_number ) SELECT d.workspace_id, d.day_number, d.event_date, COALESCE(s.checkout_count, 0) AS checkout_count, COALESCE(s.sold_count, 0) AS sold_count, COALESCE(s.total_tendered_yen, 0) AS total_tendered_yen, COALESCE(s.total_change_yen, 0) AS total_change_yen, COALESCE(s.total_tendered_yen, 0) - COALESCE(s.total_change_yen, 0) AS final_profit_yen, COALESCE(r.refunded_count, 0) AS refunded_count, COALESCE(r.refunds_yen, 0) AS refunds_yen, COALESCE(s.total_tendered_yen, 0) - COALESCE(s.total_change_yen, 0) - COALESCE(r.refunds_yen, 0) AS after_refund_yen FROM business_days AS d LEFT JOIN sale_totals AS s ON s.workspace_id = d.workspace_id AND s.day_number = d.day_number LEFT JOIN refund_totals AS r ON r.workspace_id = d.workspace_id AND r.day_number = d.day_number;

INSERT INTO workspaces ( id, kind, status, sequence, config_revision, config_snapshot_json, ticket_prefix, unit_price_yen, max_ticket_number, max_items_per_operation, max_tendered_yen, checkout_hold_seconds, last_ticket_number, last_group_number, selected_test_day, started_at_ms, ended_at_ms ) VALUES ( 'workspace-live-1', 'LIVE', 'ACTIVE', 1, 'd1-v1', '{"TICKET_PREFIX":"HC-","UNIT_PRICE_YEN":100,"MAX_TICKET_NUMBER":200,"DAILY_TICKET_LIMITS":{"1":200,"2":200,"3":200},"EVENT_DATES":{"1":null,"2":null,"3":null},"MIN_TICKET_NUMBER":1,"NUMBER_MIN_DIGITS":3,"TIME_ZONE":"Asia/Tokyo","CHECKOUT_HOLD_SECONDS":180,"MAX_ITEMS_PER_OPERATION":200,"MAX_TENDERED_YEN":100000,"POLLING_INTERVAL_MS":5000,"ALLOW_DEVELOPER_MODE":true}', 'HC-', 100, 200, 200, 100000, 180, 0, 0, 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL );

INSERT INTO business_days ( workspace_id, day_number, event_date, ticket_limit, sold_count ) VALUES ('workspace-live-1', 1, NULL, 200, 0), ('workspace-live-1', 2, NULL, 200, 0), ('workspace-live-1', 3, NULL, 200, 0);

INSERT INTO system_state ( singleton_id, mode, mode_epoch, maintenance, current_live_workspace_id, current_dev_workspace_id, updated_at_ms ) VALUES ( 1, 'LIVE', 1, 0, 'workspace-live-1', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000 );

INSERT INTO schema_migrations ( version, name, applied_at_ms ) VALUES ( 1, '0001_initial', CAST(strftime('%s', 'now') AS INTEGER) * 1000 );

PRAGMA optimize;
