import type { DayNumber, FastpassConfig } from "../../src/config/fastpass.config";
import type {
  Admission,
  AuditLog,
  BusinessDayState,
  Checkout,
  FastpassData,
  Refund,
  Sale,
  Ticket,
  TicketEvent,
  Workspace,
} from "../../src/domain/types";
import type { StateResponse } from "../../src/shared/api";
import type { SessionContext } from "./auth";
import { ApiError, sha256Hex } from "./http";

type SystemRow = {
  mode: FastpassData["system"]["mode"];
  mode_epoch: number;
  maintenance: number;
  current_live_workspace_id: string;
  current_dev_workspace_id: string | null;
};

type WorkspaceRow = {
  id: string;
  kind: Workspace["kind"];
  status: Workspace["status"];
  sequence: number;
  config_revision: string;
  config_snapshot_json: string;
  last_ticket_number: number;
  last_group_number: number;
  selected_test_day: DayNumber;
  started_at_ms: number;
  ended_at_ms: number | null;
};

function rows<T>(result: D1Result<unknown>): T[] {
  return result.results as T[];
}

function parseConfig(raw: string): FastpassConfig {
  try {
    return JSON.parse(raw) as FastpassConfig;
  } catch {
    throw new ApiError(500, "INVALID_SYSTEM_STATE", "D1の設定スナップショットを読み取れません。");
  }
}

// Read the revision before the snapshot. A concurrent write may cause an extra
// reload, but cannot attach a newer revision to an older snapshot.
export async function loadStateEtag(db: D1Database, session: SessionContext): Promise<string> {
  const revision = await db.withSession("first-primary").prepare(`SELECT mode_epoch, updated_at_ms,
    COALESCE((SELECT MAX(rowid) FROM business_operations WHERE environment = '${session.scope.key}'), 0) AS operation_revision,
    COALESCE((SELECT MAX(rowid) FROM audit_logs WHERE environment = '${session.scope.key}'), 0) AS audit_revision
    FROM system_state WHERE singleton_id = ${session.scope.id}`).first();
  if (!revision) throw new ApiError(503, "SCHEMA_NOT_INITIALIZED", "D1の初期化が完了していません。");
  return `"${await sha256Hex(JSON.stringify({ revision, environment: session.scope.key, deviceId: session.deviceId, deviceName: session.deviceName }))}"`;
}

export async function loadState(db: D1Database, session: SessionContext, nowMs = Date.now()): Promise<StateResponse> {
  const database = db.withSession("first-primary");
  const results = await database.batch([
    database.prepare(`SELECT mode, mode_epoch, maintenance, current_live_workspace_id, current_dev_workspace_id FROM system_state WHERE singleton_id = ${session.scope.id}`),
    database.prepare(`SELECT w.* FROM workspaces AS w JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE w.id = s.current_live_workspace_id OR w.id = s.current_dev_workspace_id ORDER BY w.kind, w.sequence`),
    database.prepare(`SELECT d.* FROM business_days AS d JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE d.workspace_id = s.current_live_workspace_id OR d.workspace_id = s.current_dev_workspace_id ORDER BY d.workspace_id, d.day_number`),
    database.prepare(`SELECT c.* FROM checkouts AS c JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE c.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END`),
    database.prepare(`SELECT x.* FROM sales AS x JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE x.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END ORDER BY x.purchased_at_ms`),
    database.prepare(`SELECT t.* FROM tickets AS t JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE t.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END ORDER BY t.serial_number`),
    database.prepare(`SELECT e.* FROM ticket_events AS e JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE e.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END ORDER BY e.occurred_at_ms`),
    database.prepare(`SELECT a.* FROM admissions AS a JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE a.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END ORDER BY a.occurred_at_ms`),
    database.prepare(`SELECT i.* FROM admission_items AS i JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE i.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END`),
    database.prepare(`SELECT r.* FROM checkin_reversals AS r JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE r.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END ORDER BY r.occurred_at_ms`),
    database.prepare(`SELECT r.* FROM refunds AS r JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE r.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END ORDER BY r.occurred_at_ms`),
    database.prepare(`SELECT i.* FROM refund_items AS i JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE i.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END ORDER BY i.refund_id, i.ticket_id`),
    database.prepare(`SELECT l.* FROM audit_logs AS l JOIN system_state AS s ON s.singleton_id = ${session.scope.id}
      WHERE l.environment = '${session.scope.key}' AND (l.workspace_id IS NULL OR l.workspace_id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END)
      ORDER BY l.occurred_at_ms DESC LIMIT 500`),
  ]);

  const system = rows<SystemRow>(results[0])[0];
  if (!system) throw new ApiError(503, "SCHEMA_NOT_INITIALIZED", "D1の初期化が完了していません。");

  const dayRows = rows<{ workspace_id: string; day_number: DayNumber; event_date: string | null; ticket_limit: number; sold_count: number }>(results[2]);
  const workspaces = rows<WorkspaceRow>(results[1]).map((row): Workspace => {
    const days = dayRows.filter((day) => day.workspace_id === row.id);
    const businessDays = Object.fromEntries(days.map((day) => [day.day_number, {
      dayNumber: day.day_number,
      eventDate: day.event_date,
      ticketLimit: day.ticket_limit,
      soldCount: day.sold_count,
    } satisfies BusinessDayState])) as Record<DayNumber, BusinessDayState>;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      sequence: row.sequence,
      startedAtMs: row.started_at_ms,
      endedAtMs: row.ended_at_ms,
      configRevision: row.config_revision,
      configSnapshot: parseConfig(row.config_snapshot_json),
      lastTicketNumber: row.last_ticket_number,
      lastGroupNumber: row.last_group_number,
      selectedTestDay: row.selected_test_day,
      businessDays,
      expensesConfirmedAtMs: null,
    };
  });

  const ticketRows = rows<{
    workspace_id: string; id: string; serial_number: number; sale_id: string; status: Ticket["status"];
    used_at_ms: number | null; current_use_event_id: string | null; refunded_at_ms: number | null; version: number;
  }>(results[5]);
  const tickets: Ticket[] = ticketRows.map((row) => ({
    id: row.id, workspaceId: row.workspace_id, serialNumber: row.serial_number, saleId: row.sale_id,
    status: row.status, usedAtMs: row.used_at_ms, currentUseEventId: row.current_use_event_id,
    refundedAtMs: row.refunded_at_ms, version: row.version,
  }));
  const ticketsBySale = new Map<string, Ticket[]>();
  for (const ticket of tickets) ticketsBySale.set(ticket.saleId, [...(ticketsBySale.get(ticket.saleId) || []), ticket]);

  const sales = rows<{
    workspace_id: string; id: string; checkout_id: string; group_number: number; day_number: DayNumber;
    quantity: number; unit_price_yen: number; total_yen: number; tendered_yen: number; change_yen: number;
    purchased_at_ms: number; device_id: string; handover_confirmed_at_ms: number | null;
  }>(results[4]).map((row): Sale => {
    const saleTickets = (ticketsBySale.get(row.id) || []).sort((a, b) => a.serialNumber - b.serialNumber);
    return {
      id: row.id, workspaceId: row.workspace_id, checkoutId: row.checkout_id, groupNumber: row.group_number,
      dayNumber: row.day_number, quantity: row.quantity, unitPriceYen: row.unit_price_yen, totalYen: row.total_yen,
      tenderedYen: row.tendered_yen, changeYen: row.change_yen, purchasedAtMs: row.purchased_at_ms,
      deviceId: row.device_id, cashboxId: `d1-${row.workspace_id}`, ticketIds: saleTickets.map((ticket) => ticket.id),
      ticketNumbers: saleTickets.map((ticket) => ticket.serialNumber), handoverConfirmedAtMs: row.handover_confirmed_at_ms,
    };
  });

  const checkouts = rows<{
    workspace_id: string; id: string; day_number: DayNumber; quantity: number; unit_price_yen: number;
    status: Checkout["status"]; created_at_ms: number; expires_at_ms: number; device_id: string;
  }>(results[3]).map((row): Checkout => ({
    id: row.id, workspaceId: row.workspace_id, dayNumber: row.day_number, quantity: row.quantity,
    unitPriceYen: row.unit_price_yen, status: row.status === "HELD" && row.expires_at_ms <= nowMs ? "EXPIRED" : row.status,
    createdAtMs: row.created_at_ms, expiresAtMs: row.expires_at_ms, deviceId: row.device_id, cashboxId: `d1-${row.workspace_id}`,
  }));

  const events = rows<{
    workspace_id: string; id: string; ticket_id: string; type: TicketEvent["type"]; from_status: TicketEvent["fromStatus"];
    to_status: TicketEvent["toStatus"]; occurred_at_ms: number; device_id: string; operation_id: string;
    reason: string | null; reversed_event_id: string | null;
  }>(results[6]).map((row): TicketEvent => ({
    id: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id, type: row.type,
    fromStatus: row.from_status, toStatus: row.to_status, occurredAtMs: row.occurred_at_ms,
    deviceId: row.device_id, operationId: row.operation_id, reason: row.reason, reversedEventId: row.reversed_event_id,
  }));

  const admissionItems = rows<{ admission_id: string; ticket_id: string }>(results[8]);
  const admissions = rows<{ workspace_id: string; id: string; operation_id: string; occurred_at_ms: number; device_id: string }>(results[7]).map((row): Admission => ({
    id: row.id, workspaceId: row.workspace_id, ticketIds: admissionItems.filter((item) => item.admission_id === row.id).map((item) => item.ticket_id),
    operationId: row.operation_id, occurredAtMs: row.occurred_at_ms, deviceId: row.device_id,
  }));

  const refundItems = rows<{ refund_id: string; ticket_id: string; refund_yen: number }>(results[11]);
  const refunds = rows<{
    workspace_id: string; id: string; operation_id: string; total_yen: number; reason: string;
    occurred_at_ms: number; device_id: string; handover_confirmed_at_ms: number | null;
  }>(results[10]).map((row): Refund => {
    const items = refundItems.filter((item) => item.refund_id === row.id);
    return {
      id: row.id, workspaceId: row.workspace_id, ticketIds: items.map((item) => item.ticket_id),
      refundAmountsYen: items.map((item) => item.refund_yen), totalYen: row.total_yen, reason: row.reason,
      operationId: row.operation_id, occurredAtMs: row.occurred_at_ms, deviceId: row.device_id,
      cashboxId: `d1-${row.workspace_id}`, handoverConfirmedAtMs: row.handover_confirmed_at_ms,
    };
  });

  const data: FastpassData = {
    schemaVersion: 1,
    savedAtMs: nowMs,
    system: {
      environment: session.scope.key,
      mode: system.mode,
      modeEpoch: system.mode_epoch,
      maintenance: system.maintenance === 1,
      liveWorkspaceId: system.current_live_workspace_id,
      devWorkspaceId: system.current_dev_workspace_id,
      device: { id: session.deviceId, name: session.deviceName, createdAtMs: 0 },
    },
    workspaces,
    checkouts,
    sales,
    tickets,
    ticketEvents: events,
    admissions,
    checkinReversals: rows<{
      workspace_id: string; id: string; ticket_id: string; use_event_id: string; reason: string;
      operation_id: string; occurred_at_ms: number; device_id: string;
    }>(results[9]).map((row) => ({
      id: row.id, workspaceId: row.workspace_id, ticketId: row.ticket_id, useEventId: row.use_event_id,
      reason: row.reason, operationId: row.operation_id, occurredAtMs: row.occurred_at_ms, deviceId: row.device_id,
    })),
    refunds,
    cashboxes: [], cashLedger: [], expenses: [], cashCounts: [], operations: [],
    auditLogs: rows<{
      id: string; workspace_id: string | null; type: string; status: AuditLog["status"];
      occurred_at_ms: number; device_id: string | null; operation_id: string | null; detail: string;
    }>(results[12]).map((row): AuditLog => ({
      id: row.id, workspaceId: row.workspace_id, type: row.type, status: row.status,
      occurredAtMs: row.occurred_at_ms, deviceId: row.device_id || "unknown", operationId: row.operation_id, detail: row.detail,
    })),
  };
  return { data, serverNowMs: nowMs };
}
