import type { DayNumber } from "../../src/config/fastpass.config";
import type { MutationPayload, MutationRequest } from "../../src/shared/api";
import type { SessionContext } from "./auth";
import { ApiError, getJstDateString, isUuid, requireInteger, requireText, sha256Hex } from "./http";

type ActiveContext = {
  mode: "LIVE" | "DEVELOPMENT";
  modeEpoch: number;
  maintenance: boolean;
  liveWorkspaceId: string;
  devWorkspaceId: string | null;
  workspaceId: string;
  kind: "LIVE" | "DEV";
  sequence: number;
  selectedTestDay: DayNumber;
  unitPriceYen: number;
  maxTicketNumber: number;
  maxItemsPerOperation: number;
  maxTenderedYen: number;
  holdSeconds: number;
  lastTicketNumber: number;
  lastGroupNumber: number;
  configRevision: string;
  configSnapshotJson: string;
  ticketPrefix: string;
};

type OperationResult = { workspace_id: string; request_hash: string; result_json: string };

async function activeContext(db: D1Database): Promise<ActiveContext> {
  const row = await db.prepare(
    `SELECT s.mode, s.mode_epoch, s.maintenance, s.current_live_workspace_id, s.current_dev_workspace_id,
            w.id AS workspace_id, w.kind, w.sequence, w.selected_test_day, w.unit_price_yen,
            w.max_ticket_number, w.max_items_per_operation, w.max_tendered_yen, w.checkout_hold_seconds,
            w.last_ticket_number, w.last_group_number, w.config_revision, w.config_snapshot_json, w.ticket_prefix
       FROM system_state AS s
       JOIN workspaces AS w ON w.id = CASE WHEN s.mode = 'DEVELOPMENT' THEN s.current_dev_workspace_id ELSE s.current_live_workspace_id END
      WHERE s.singleton_id = 1 AND w.status = 'ACTIVE'`,
  ).first<{
    mode: "LIVE" | "DEVELOPMENT"; mode_epoch: number; maintenance: number;
    current_live_workspace_id: string; current_dev_workspace_id: string | null; workspace_id: string;
    kind: "LIVE" | "DEV"; sequence: number; selected_test_day: DayNumber; unit_price_yen: number;
    max_ticket_number: number; max_items_per_operation: number; max_tendered_yen: number;
    checkout_hold_seconds: number; last_ticket_number: number; last_group_number: number;
    config_revision: string; config_snapshot_json: string; ticket_prefix: string;
  }>();
  if (!row) throw new ApiError(503, "INVALID_SYSTEM_STATE", "有効なD1運用領域を確認できません。");
  return {
    mode: row.mode, modeEpoch: row.mode_epoch, maintenance: row.maintenance === 1,
    liveWorkspaceId: row.current_live_workspace_id, devWorkspaceId: row.current_dev_workspace_id,
    workspaceId: row.workspace_id, kind: row.kind, sequence: row.sequence,
    selectedTestDay: row.selected_test_day, unitPriceYen: row.unit_price_yen,
    maxTicketNumber: row.max_ticket_number, maxItemsPerOperation: row.max_items_per_operation,
    maxTenderedYen: row.max_tendered_yen, holdSeconds: row.checkout_hold_seconds,
    lastTicketNumber: row.last_ticket_number, lastGroupNumber: row.last_group_number,
    configRevision: row.config_revision, configSnapshotJson: row.config_snapshot_json, ticketPrefix: row.ticket_prefix,
  };
}

function activeMode(context: ActiveContext): string {
  return context.kind === "DEV" ? "DEVELOPMENT" : "LIVE";
}

function assertion(db: D1Database, context: ActiveContext, requestId: string, key: string, expected: number, nowMs: number): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO transaction_assertions (workspace_id, request_id, assertion_key, expected_count, actual_count, created_at_ms) VALUES (?, ?, ?, ?, changes(), ?)",
  ).bind(context.workspaceId, requestId, key, expected, nowMs);
}

function operation(db: D1Database, workspaceId: string, requestId: string, action: string, requestHash: string, result: unknown, nowMs: number): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO business_operations (workspace_id, request_id, type, request_hash, result_json, committed_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(workspaceId, requestId, action, requestHash, JSON.stringify(result), nowMs);
}

function audit(db: D1Database, session: SessionContext, workspaceId: string | null, requestId: string, type: string, detail: string, nowMs: number): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO audit_logs (id, workspace_id, device_id, session_id, operation_id, type, status, detail, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'SUCCESS', ?, ?)",
  ).bind(crypto.randomUUID(), workspaceId, session.deviceId, session.id, requestId, type, detail, nowMs);
}

async function existing(db: D1Database, requestId: string, requestHash: string): Promise<unknown | null> {
  const result = await db.prepare(
    "SELECT workspace_id, request_hash, result_json FROM business_operations WHERE request_id = ? ORDER BY committed_at_ms DESC LIMIT 2",
  ).bind(requestId).all<OperationResult>();
  if (result.results.length === 0) return null;
  const row = result.results[0];
  if (row.request_hash !== requestHash) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "同じ操作IDが異なる内容で使われています。");
  }
  return JSON.parse(row.result_json) as unknown;
}

function ensureRequest(request: MutationRequest): void {
  if (!isUuid(request.requestId)) throw new ApiError(400, "INVALID_REQUEST_ID", "操作IDを確認できません。");
  if (!Number.isSafeInteger(request.modeEpoch) || request.modeEpoch < 1) throw new ApiError(400, "INVALID_MODE_EPOCH", "画面を再読み込みしてください。");
  if (!request.payload || typeof request.payload !== "object") throw new ApiError(400, "INVALID_INPUT", "操作内容を確認できません。");
}

function ensureCurrent(context: ActiveContext, request: MutationRequest, allowMaintenance = false): void {
  if (context.modeEpoch !== request.modeEpoch) throw new ApiError(409, "MODE_CHANGED", "営業状態またはモードが変わりました。画面を更新してください。");
  if (!allowMaintenance && context.maintenance) throw new ApiError(409, "MAINTENANCE", "営業停止中です。管理画面から営業を再開してください。");
}

async function resolveDay(db: D1Database, context: ActiveContext, nowMs: number): Promise<DayNumber> {
  if (context.kind === "DEV") return context.selectedTestDay;
  const days = await db.prepare(
    "SELECT day_number, event_date FROM business_days WHERE workspace_id = ? ORDER BY day_number",
  ).bind(context.workspaceId).all<{ day_number: DayNumber; event_date: string | null }>();
  if (days.results.length !== 3 || days.results.some((day) => day.event_date === null)) {
    throw new ApiError(409, "EVENT_DATE_NOT_CONFIGURED", "開催日が未設定のため、本番販売を開始できません。開発者モードで確認してください。");
  }
  const today = getJstDateString(nowMs);
  const found = days.results.find((day) => day.event_date === today);
  if (!found) throw new ApiError(409, "OUTSIDE_SALES_DATE", "本日は設定された開催日ではないため、本番販売を開始できません。");
  return found.day_number;
}

function endOfJstDay(nowMs: number): number {
  return Date.parse(`${getJstDateString(nowMs)}T23:59:59.999+09:00`);
}

async function createCheckout(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request);
  const quantity = requireInteger(request.payload.quantity, "人数", 1, context.maxItemsPerOperation);
  const dayNumber = await resolveDay(db, context, nowMs);
  const id = crypto.randomUUID();
  const expiresAtMs = Math.min(nowMs + context.holdSeconds * 1000, endOfJstDay(nowMs));
  const result = {
    id, workspaceId: context.workspaceId, dayNumber, quantity, unitPriceYen: context.unitPriceYen,
    status: "HELD", createdAtMs: nowMs, expiresAtMs, deviceId: session.deviceId, cashboxId: `d1-${context.workspaceId}`,
  };
  await db.batch([
    db.prepare(`INSERT INTO checkouts (workspace_id, id, request_id, day_number, quantity, unit_price_yen, status, created_at_ms, expires_at_ms, device_id)
      SELECT ?, ?, ?, ?, ?, w.unit_price_yen, 'HELD', ?, ?, ? FROM workspaces AS w
      JOIN system_state AS s ON s.singleton_id = 1
      JOIN business_days AS d ON d.workspace_id = w.id AND d.day_number = ?
      WHERE w.id = ? AND w.status = 'ACTIVE' AND s.mode = ? AND s.mode_epoch = ? AND s.maintenance = 0
        AND (w.kind = 'DEV' OR (
          d.sold_count + ? + COALESCE((SELECT SUM(quantity) FROM checkouts WHERE workspace_id = w.id AND day_number = d.day_number AND status = 'HELD' AND expires_at_ms > ?), 0) <= d.ticket_limit
          AND w.last_ticket_number + ? + COALESCE((SELECT SUM(quantity) FROM checkouts WHERE workspace_id = w.id AND status = 'HELD' AND expires_at_ms > ?), 0) <= w.max_ticket_number
        ))`).bind(context.workspaceId, id, request.requestId, dayNumber, quantity, nowMs, expiresAtMs, session.deviceId, dayNumber,
          context.workspaceId, activeMode(context), request.modeEpoch, quantity, nowMs, quantity, nowMs),
    assertion(db, context, request.requestId, "checkout-created", 1, nowMs),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, "CHECKOUT_HELD", `${quantity}枚を一時確保しました。`, nowMs),
  ]);
  return result;
}

async function cancelCheckout(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request, true);
  const checkoutId = requireText(request.payload.checkoutId, "一時確保ID", 100);
  const result = { cancelled: true, checkoutId };
  await db.batch([
    db.prepare(`UPDATE checkouts SET status = 'CANCELLED'
      WHERE workspace_id = ? AND id = ? AND status = 'HELD'
        AND EXISTS (SELECT 1 FROM system_state WHERE singleton_id = 1 AND mode = ? AND mode_epoch = ?)`).bind(
      context.workspaceId, checkoutId, activeMode(context), request.modeEpoch,
    ),
    assertion(db, context, request.requestId, "checkout-cancelled", 1, nowMs),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, "CHECKOUT_CANCELLED", "一時確保を解除しました。", nowMs),
  ]);
  return result;
}

async function finalizeSale(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request);
  const checkoutId = requireText(request.payload.checkoutId, "一時確保ID", 100);
  const checkout = await db.prepare(
    "SELECT day_number, quantity, unit_price_yen, expires_at_ms, status FROM checkouts WHERE workspace_id = ? AND id = ?",
  ).bind(context.workspaceId, checkoutId).first<{ day_number: DayNumber; quantity: number; unit_price_yen: number; expires_at_ms: number; status: string }>();
  if (!checkout || checkout.status !== "HELD" || checkout.expires_at_ms <= nowMs) throw new ApiError(409, "HOLD_EXPIRED", "一時確保の期限が切れました。人数入力からやり直してください。");
  const dayNumber = await resolveDay(db, context, nowMs);
  if (dayNumber !== checkout.day_number) throw new ApiError(409, "HOLD_EXPIRED", "日付またはテスト日が変わったため確定できません。");
  const totalYen = checkout.quantity * checkout.unit_price_yen;
  const tenderedYen = requireInteger(request.payload.tenderedYen, "預り金", totalYen, context.maxTenderedYen);
  const saleId = crypto.randomUUID();
  const itemJson = JSON.stringify(Array.from({ length: checkout.quantity }, (_, index) => ({
    index, ticketId: crypto.randomUUID(), eventId: crypto.randomUUID(),
  })));
  const initialResult = { saleId, checkoutId, groupNumber: 0, ticketNumbers: [] as number[], totalYen, tenderedYen, changeYen: tenderedYen - totalYen, purchasedAtMs: nowMs };
  await db.batch([
    db.prepare(`UPDATE checkouts SET status = 'COMPLETED' WHERE workspace_id = ? AND id = ? AND status = 'HELD' AND expires_at_ms > ?
      AND EXISTS (SELECT 1 FROM system_state WHERE singleton_id = 1 AND mode = ? AND mode_epoch = ? AND maintenance = 0)`).bind(
      context.workspaceId, checkoutId, nowMs, activeMode(context), request.modeEpoch,
    ),
    assertion(db, context, request.requestId, "checkout-completed", 1, nowMs),
    db.prepare(`UPDATE workspaces SET last_ticket_number = last_ticket_number + ?, last_group_number = last_group_number + 1
      WHERE id = ? AND status = 'ACTIVE' AND (kind = 'DEV' OR last_ticket_number + ? <= max_ticket_number)`).bind(
      checkout.quantity, context.workspaceId, checkout.quantity,
    ),
    assertion(db, context, request.requestId, "numbers-allocated", 1, nowMs),
    db.prepare(`UPDATE business_days SET sold_count = sold_count + ? WHERE workspace_id = ? AND day_number = ?
      AND (? = 'DEV' OR sold_count + ? <= ticket_limit)`).bind(checkout.quantity, context.workspaceId, dayNumber, context.kind, checkout.quantity),
    assertion(db, context, request.requestId, "daily-count-updated", 1, nowMs),
    db.prepare(`INSERT INTO sales (workspace_id, id, checkout_id, group_number, day_number, quantity, unit_price_yen, total_yen, tendered_yen, change_yen, purchased_at_ms, device_id, handover_confirmed_at_ms)
      SELECT ?, ?, ?, last_group_number, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM workspaces WHERE id = ?`).bind(
      context.workspaceId, saleId, checkoutId, dayNumber, checkout.quantity, checkout.unit_price_yen,
      totalYen, tenderedYen, tenderedYen - totalYen, nowMs, session.deviceId, context.workspaceId,
    ),
    db.prepare(`INSERT INTO tickets (workspace_id, id, serial_number, sale_id, status, used_at_ms, current_use_event_id, refunded_at_ms, version)
      SELECT ?, json_extract(j.value, '$.ticketId'), w.last_ticket_number - ? + CAST(j.key AS INTEGER) + 1, ?, 'ISSUED', NULL, NULL, NULL, 0
      FROM json_each(?) AS j JOIN workspaces AS w ON w.id = ?`).bind(context.workspaceId, checkout.quantity, saleId, itemJson, context.workspaceId),
    db.prepare(`INSERT INTO ticket_events (workspace_id, id, ticket_id, type, from_status, to_status, occurred_at_ms, device_id, operation_id, reason, reversed_event_id)
      SELECT ?, json_extract(value, '$.eventId'), json_extract(value, '$.ticketId'), 'SALE', 'UNISSUED', 'ISSUED', ?, ?, ?, NULL, NULL FROM json_each(?)`).bind(
      context.workspaceId, nowMs, session.deviceId, request.requestId, itemJson,
    ),
    db.prepare(`INSERT INTO business_operations (workspace_id, request_id, type, request_hash, result_json, committed_at_ms)
      SELECT ?, ?, ?, ?, json_object(
        'saleId', ?, 'checkoutId', ?, 'groupNumber', s.group_number,
        'ticketNumbers', json((SELECT json_group_array(serial_number) FROM (SELECT serial_number FROM tickets WHERE workspace_id = ? AND sale_id = ? ORDER BY serial_number))),
        'totalYen', ?, 'tenderedYen', ?, 'changeYen', ?, 'purchasedAtMs', ?), ?
      FROM sales AS s WHERE s.workspace_id = ? AND s.id = ?`).bind(
      context.workspaceId, request.requestId, request.action, hash, saleId, checkoutId, context.workspaceId, saleId,
      totalYen, tenderedYen, tenderedYen - totalYen, nowMs, nowMs, context.workspaceId, saleId,
    ),
    audit(db, session, context.workspaceId, request.requestId, "SALE_COMMITTED", `${checkout.quantity}枚を販売確定しました。`, nowMs),
  ]);
  const saved = await existing(db, request.requestId, hash);
  return saved || initialResult;
}

type TicketRow = { id: string; serial_number: number; status: "ISSUED" | "USED" | "REFUNDED"; current_use_event_id: string | null; sale_id: string; unit_price_yen: number; day_number: DayNumber };

async function ticketRows(db: D1Database, workspaceId: string, serialNumbers: number[]): Promise<TicketRow[]> {
  const unique = [...new Set(serialNumbers)];
  if (unique.length !== serialNumbers.length || unique.length < 1 || unique.length > 200 || unique.some((number) => !Number.isSafeInteger(number) || number < 1)) {
    throw new ApiError(400, "INVALID_INPUT", "チケット番号は重複のない1～200件の正整数で指定してください。");
  }
  const result = await db.prepare(`SELECT t.id, t.serial_number, t.status, t.current_use_event_id, t.sale_id, s.unit_price_yen, s.day_number
    FROM tickets AS t JOIN sales AS s ON s.workspace_id = t.workspace_id AND s.id = t.sale_id
    WHERE t.workspace_id = ? AND t.serial_number IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY t.serial_number`).bind(
    workspaceId, JSON.stringify(unique),
  ).all<TicketRow>();
  if (result.results.length !== unique.length) throw new ApiError(404, "TICKET_NOT_FOUND", "販売記録のないチケット番号が含まれています。");
  return result.results;
}

async function checkin(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number, saleId?: string) {
  ensureCurrent(context, request);
  let selected: TicketRow[];
  if (saleId) {
    const result = await db.prepare(`SELECT t.id, t.serial_number, t.status, t.current_use_event_id, t.sale_id, s.unit_price_yen, s.day_number
      FROM tickets AS t JOIN sales AS s ON s.workspace_id = t.workspace_id AND s.id = t.sale_id
      WHERE t.workspace_id = ? AND t.sale_id = ? ORDER BY t.serial_number`).bind(context.workspaceId, saleId).all<TicketRow>();
    selected = result.results;
    if (selected.length < 1) throw new ApiError(404, "SALE_NOT_FOUND", "販売記録を確認できません。");
  } else {
    selected = await ticketRows(db, context.workspaceId, request.payload.serialNumbers || []);
  }
  const mapping = JSON.stringify(selected.map((ticket) => ({ ticketId: ticket.id, eventId: crypto.randomUUID(), serialNumber: ticket.serial_number })));
  const admissionId = crypto.randomUUID();
  const result = { admissionId, ticketNumbers: selected.map((ticket) => ticket.serial_number) };
  const statements: D1PreparedStatement[] = [];
  if (saleId) {
    statements.push(db.prepare(`UPDATE sales SET handover_confirmed_at_ms = COALESCE(handover_confirmed_at_ms, ?)
      WHERE workspace_id = ? AND id = ? AND EXISTS (SELECT 1 FROM system_state WHERE singleton_id = 1 AND mode = ? AND mode_epoch = ? AND maintenance = 0)`).bind(
      nowMs, context.workspaceId, saleId, activeMode(context), request.modeEpoch,
    ));
    statements.push(assertion(db, context, request.requestId, "sale-handover-confirmed", 1, nowMs));
  }
  statements.push(
    db.prepare(`UPDATE tickets SET status = 'USED', used_at_ms = ?, refunded_at_ms = NULL,
      current_use_event_id = (SELECT json_extract(value, '$.eventId') FROM json_each(?) WHERE json_extract(value, '$.ticketId') = tickets.id), version = version + 1
      WHERE workspace_id = ? AND status = 'ISSUED' AND id IN (SELECT json_extract(value, '$.ticketId') FROM json_each(?))
        AND EXISTS (SELECT 1 FROM system_state WHERE singleton_id = 1 AND mode = ? AND mode_epoch = ? AND maintenance = 0)`).bind(
      nowMs, mapping, context.workspaceId, mapping, activeMode(context), request.modeEpoch,
    ),
    assertion(db, context, request.requestId, "tickets-checked-in", selected.length, nowMs),
    db.prepare("INSERT INTO admissions (workspace_id, id, operation_id, occurred_at_ms, device_id) VALUES (?, ?, ?, ?, ?)").bind(
      context.workspaceId, admissionId, request.requestId, nowMs, session.deviceId,
    ),
    db.prepare(`INSERT INTO admission_items (workspace_id, admission_id, ticket_id)
      SELECT ?, ?, json_extract(value, '$.ticketId') FROM json_each(?)`).bind(context.workspaceId, admissionId, mapping),
    db.prepare(`INSERT INTO ticket_events (workspace_id, id, ticket_id, type, from_status, to_status, occurred_at_ms, device_id, operation_id, reason, reversed_event_id)
      SELECT ?, json_extract(value, '$.eventId'), json_extract(value, '$.ticketId'), 'CHECKIN', 'ISSUED', 'USED', ?, ?, ?, NULL, NULL FROM json_each(?)`).bind(
      context.workspaceId, nowMs, session.deviceId, request.requestId, mapping,
    ),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, saleId ? "SALE_HANDOVER_AND_CHECKIN" : "CHECKIN_COMMITTED", `${selected.length}枚の入場を確定しました。`, nowMs),
  );
  await db.batch(statements);
  return result;
}

async function reverseCheckin(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request);
  const serialNumber = requireInteger(request.payload.serialNumber, "チケット番号", 1, 999_999_999);
  const reason = requireText(request.payload.reason, "理由", 100);
  const expected = requireText(request.payload.expectedUseEventId, "使用イベント", 100);
  const [ticket] = await ticketRows(db, context.workspaceId, [serialNumber]);
  const eventId = crypto.randomUUID();
  const reversalId = crypto.randomUUID();
  const result = { reversed: true };
  await db.batch([
    db.prepare(`UPDATE tickets SET status = 'ISSUED', used_at_ms = NULL, current_use_event_id = NULL, version = version + 1
      WHERE workspace_id = ? AND id = ? AND status = 'USED' AND current_use_event_id = ?
        AND EXISTS (SELECT 1 FROM system_state WHERE singleton_id = 1 AND mode = ? AND mode_epoch = ? AND maintenance = 0)`).bind(
      context.workspaceId, ticket.id, expected, activeMode(context), request.modeEpoch,
    ),
    assertion(db, context, request.requestId, "ticket-checkin-reversed", 1, nowMs),
    db.prepare("INSERT INTO checkin_reversals (workspace_id, id, ticket_id, use_event_id, reason, operation_id, occurred_at_ms, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      context.workspaceId, reversalId, ticket.id, expected, reason, request.requestId, nowMs, session.deviceId,
    ),
    db.prepare("INSERT INTO ticket_events (workspace_id, id, ticket_id, type, from_status, to_status, occurred_at_ms, device_id, operation_id, reason, reversed_event_id) VALUES (?, ?, ?, 'CHECKIN_REVERSAL', 'USED', 'ISSUED', ?, ?, ?, ?, ?)").bind(
      context.workspaceId, eventId, ticket.id, nowMs, session.deviceId, request.requestId, reason, expected,
    ),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, "CHECKIN_REVERSED", `番号${serialNumber}の使用済みを取り消しました。`, nowMs),
  ]);
  return result;
}

async function refund(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request);
  const reason = requireText(request.payload.reason, "理由", 100);
  const selected = await ticketRows(db, context.workspaceId, request.payload.serialNumbers || []);
  const totalYen = selected.reduce((sum, ticket) => sum + ticket.unit_price_yen, 0);
  const dayNumber = selected[0].day_number;
  if (selected.some((ticket) => ticket.day_number !== dayNumber)) throw new ApiError(409, "MIXED_SALES_DAYS", "異なる販売日の券を一度に払い戻せません。");
  const refundId = crypto.randomUUID();
  const mapping = JSON.stringify(selected.map((ticket) => ({ ticketId: ticket.id, saleId: ticket.sale_id, refundYen: ticket.unit_price_yen, eventId: crypto.randomUUID() })));
  const result = {
    id: refundId, workspaceId: context.workspaceId, ticketIds: selected.map((ticket) => ticket.id),
    refundAmountsYen: selected.map((ticket) => ticket.unit_price_yen), totalYen, reason, operationId: request.requestId,
    occurredAtMs: nowMs, deviceId: session.deviceId, cashboxId: `d1-${context.workspaceId}`, handoverConfirmedAtMs: null,
  };
  await db.batch([
    db.prepare(`UPDATE tickets SET status = 'REFUNDED', used_at_ms = NULL, current_use_event_id = NULL, refunded_at_ms = ?, version = version + 1
      WHERE workspace_id = ? AND status = 'ISSUED' AND id IN (SELECT json_extract(value, '$.ticketId') FROM json_each(?))
        AND EXISTS (SELECT 1 FROM system_state WHERE singleton_id = 1 AND mode = ? AND mode_epoch = ? AND maintenance = 0)`).bind(
      nowMs, context.workspaceId, mapping, activeMode(context), request.modeEpoch,
    ),
    assertion(db, context, request.requestId, "tickets-refunded", selected.length, nowMs),
    db.prepare("INSERT INTO refunds (workspace_id, id, operation_id, day_number, total_yen, reason, occurred_at_ms, device_id, handover_confirmed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)").bind(
      context.workspaceId, refundId, request.requestId, dayNumber, totalYen, reason, nowMs, session.deviceId,
    ),
    db.prepare(`INSERT INTO refund_items (workspace_id, refund_id, ticket_id, sale_id, refund_yen)
      SELECT ?, ?, json_extract(value, '$.ticketId'), json_extract(value, '$.saleId'), json_extract(value, '$.refundYen') FROM json_each(?)`).bind(
      context.workspaceId, refundId, mapping,
    ),
    db.prepare(`INSERT INTO ticket_events (workspace_id, id, ticket_id, type, from_status, to_status, occurred_at_ms, device_id, operation_id, reason, reversed_event_id)
      SELECT ?, json_extract(value, '$.eventId'), json_extract(value, '$.ticketId'), 'REFUND', 'ISSUED', 'REFUNDED', ?, ?, ?, ?, NULL FROM json_each(?)`).bind(
      context.workspaceId, nowMs, session.deviceId, request.requestId, reason, mapping,
    ),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, "REFUND_COMMITTED", `${selected.length}枚、${totalYen}円を払い戻しました。`, nowMs),
  ]);
  return result;
}

async function confirmHandover(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request, true);
  if (request.payload.kind !== "SALE" && request.payload.kind !== "REFUND") throw new ApiError(400, "INVALID_INPUT", "受渡種別を確認できません。");
  const sourceId = requireText(request.payload.sourceId, "対象ID", 100);
  const table = request.payload.kind === "SALE" ? "sales" : "refunds";
  const result = { confirmed: true };
  await db.batch([
    db.prepare(`UPDATE ${table} SET handover_confirmed_at_ms = COALESCE(handover_confirmed_at_ms, ?) WHERE workspace_id = ? AND id = ?`).bind(
      nowMs, context.workspaceId, sourceId,
    ),
    assertion(db, context, request.requestId, "handover-confirmed", 1, nowMs),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, `${request.payload.kind}_HANDOVER_CONFIRMED`, "受渡しを確認しました。", nowMs),
  ]);
  return result;
}

async function setMaintenance(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request, true);
  if (typeof request.payload.maintenance !== "boolean") throw new ApiError(400, "INVALID_INPUT", "営業状態を確認できません。");
  const value = request.payload.maintenance ? 1 : 0;
  const result = { maintenance: request.payload.maintenance };
  await db.batch([
    db.prepare("UPDATE system_state SET maintenance = ?, mode_epoch = mode_epoch + 1, updated_at_ms = ? WHERE singleton_id = 1 AND mode = ? AND mode_epoch = ?").bind(
      value, nowMs, activeMode(context), request.modeEpoch,
    ),
    assertion(db, context, request.requestId, "maintenance-updated", 1, nowMs),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, value ? "MAINTENANCE_ENABLED" : "MAINTENANCE_DISABLED", value ? "営業を停止しました。" : "営業を再開しました。", nowMs),
  ]);
  return result;
}

async function enableDev(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request, true);
  if (context.kind !== "LIVE" || context.mode !== "LIVE") throw new ApiError(409, "MODE_CHANGED", "現在の状態では開発者モードを開始できません。");
  const pending = await db.prepare("SELECT COUNT(*) AS count FROM sales WHERE workspace_id = ? AND handover_confirmed_at_ms IS NULL").bind(context.workspaceId).first<{ count: number }>();
  const pendingRefunds = await db.prepare("SELECT COUNT(*) AS count FROM refunds WHERE workspace_id = ? AND handover_confirmed_at_ms IS NULL").bind(context.workspaceId).first<{ count: number }>();
  if ((pending?.count || 0) + (pendingRefunds?.count || 0) > 0) throw new ApiError(409, "PENDING_HANDOVER_EXISTS", "受渡未確認の販売または払い戻しがあります。");
  const devId = crypto.randomUUID();
  const nextSequence = (await db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM workspaces WHERE kind = 'DEV'").first<{ value: number }>())?.value || 1;
  const result = { devWorkspaceId: devId, sequence: nextSequence };
  await db.batch([
    db.prepare(`INSERT INTO workspaces (id, kind, status, sequence, config_revision, config_snapshot_json, ticket_prefix, unit_price_yen, max_ticket_number, max_items_per_operation, max_tendered_yen, checkout_hold_seconds, last_ticket_number, last_group_number, selected_test_day, started_at_ms, ended_at_ms)
      VALUES (?, 'DEV', 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL)`).bind(
      devId, nextSequence, context.configRevision, context.configSnapshotJson, context.ticketPrefix, context.unitPriceYen,
      context.maxTicketNumber, context.maxItemsPerOperation, context.maxTenderedYen, context.holdSeconds, nowMs,
    ),
    db.prepare("INSERT INTO business_days (workspace_id, day_number, event_date, ticket_limit, sold_count) VALUES (?, 1, NULL, ?, 0), (?, 2, NULL, ?, 0), (?, 3, NULL, ?, 0)").bind(
      devId, context.maxTicketNumber, devId, context.maxTicketNumber, devId, context.maxTicketNumber,
    ),
    db.prepare("UPDATE checkouts SET status = 'CANCELLED' WHERE workspace_id = ? AND status = 'HELD'").bind(context.workspaceId),
    db.prepare(`UPDATE system_state SET mode = 'DEVELOPMENT', current_dev_workspace_id = ?, maintenance = 0, mode_epoch = mode_epoch + 1, updated_at_ms = ?
      WHERE singleton_id = 1 AND mode = 'LIVE' AND mode_epoch = ? AND current_live_workspace_id = ?
        AND NOT EXISTS (SELECT 1 FROM sales WHERE workspace_id = ? AND handover_confirmed_at_ms IS NULL)
        AND NOT EXISTS (SELECT 1 FROM refunds WHERE workspace_id = ? AND handover_confirmed_at_ms IS NULL)`).bind(
      devId, nowMs, request.modeEpoch, context.workspaceId, context.workspaceId, context.workspaceId,
    ),
    assertion(db, context, request.requestId, "developer-mode-enabled", 1, nowMs),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, null, request.requestId, "DEVELOPER_MODE_ENABLED", "新しいDEV領域を作成しました。", nowMs),
  ]);
  return result;
}

async function setDevDay(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request);
  if (context.kind !== "DEV") throw new ApiError(409, "MODE_CHANGED", "開発者モードではありません。");
  const day = requireInteger(request.payload.dayNumber, "テスト日", 1, 3) as DayNumber;
  const result = { dayNumber: day };
  await db.batch([
    db.prepare(`UPDATE workspaces SET selected_test_day = ? WHERE id = ? AND kind = 'DEV' AND status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM checkouts WHERE workspace_id = ? AND status = 'HELD' AND expires_at_ms > ?)`).bind(day, context.workspaceId, context.workspaceId, nowMs),
    assertion(db, context, request.requestId, "developer-day-updated", 1, nowMs),
    db.prepare("UPDATE system_state SET mode_epoch = mode_epoch + 1, updated_at_ms = ? WHERE singleton_id = 1 AND mode = 'DEVELOPMENT' AND mode_epoch = ? AND current_dev_workspace_id = ?").bind(
      nowMs, request.modeEpoch, context.workspaceId,
    ),
    assertion(db, context, request.requestId, "developer-epoch-updated", 1, nowMs),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, "DEVELOPER_DAY_CHANGED", `テスト日を${day}日目に変更しました。`, nowMs),
  ]);
  return result;
}

async function disableDev(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request, true);
  if (context.kind !== "DEV" || !context.devWorkspaceId) throw new ApiError(409, "MODE_CHANGED", "開発者モードではありません。");
  const liveId = context.liveWorkspaceId;
  const result = { deleted: true };
  await db.batch([
    db.prepare("UPDATE system_state SET mode = 'LIVE', current_dev_workspace_id = NULL, maintenance = 1, mode_epoch = mode_epoch + 1, updated_at_ms = ? WHERE singleton_id = 1 AND mode = 'DEVELOPMENT' AND mode_epoch = ? AND current_dev_workspace_id = ?").bind(
      nowMs, request.modeEpoch, context.workspaceId,
    ),
    assertion(db, context, request.requestId, "developer-mode-disabled", 1, nowMs),
    db.prepare("DELETE FROM workspaces WHERE id = ? AND kind = 'DEV'").bind(context.workspaceId),
    operation(db, liveId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, null, request.requestId, "DEVELOPER_MODE_DISABLED", "DEV領域とテスト業務データを削除しました。", nowMs),
  ]);
  return result;
}

async function resetLive(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request, true);
  if (context.kind !== "LIVE" || !context.maintenance) throw new ApiError(409, "RESET_NOT_ALLOWED", "本番リセットにはLIVEモードと営業停止が必要です。");
  const pending = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM sales WHERE workspace_id = ? AND handover_confirmed_at_ms IS NULL) +
    (SELECT COUNT(*) FROM refunds WHERE workspace_id = ? AND handover_confirmed_at_ms IS NULL) AS count`).bind(context.workspaceId, context.workspaceId).first<{ count: number }>();
  if ((pending?.count || 0) > 0) throw new ApiError(409, "PENDING_HANDOVER_EXISTS", "受渡未確認の記録があります。");
  const newId = crypto.randomUUID();
  const nextSequence = context.sequence + 1;
  const result = { workspaceId: newId, sequence: nextSequence };
  await db.batch([
    db.prepare("UPDATE workspaces SET status = 'ARCHIVED', ended_at_ms = ? WHERE id = ? AND kind = 'LIVE' AND status = 'ACTIVE'").bind(nowMs, context.workspaceId),
    assertion(db, context, request.requestId, "live-archived", 1, nowMs),
    db.prepare(`INSERT INTO workspaces (id, kind, status, sequence, config_revision, config_snapshot_json, ticket_prefix, unit_price_yen, max_ticket_number, max_items_per_operation, max_tendered_yen, checkout_hold_seconds, last_ticket_number, last_group_number, selected_test_day, started_at_ms, ended_at_ms)
      VALUES (?, 'LIVE', 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NULL)`).bind(
      newId, nextSequence, context.configRevision, context.configSnapshotJson, context.ticketPrefix, context.unitPriceYen,
      context.maxTicketNumber, context.maxItemsPerOperation, context.maxTenderedYen, context.holdSeconds, nowMs,
    ),
    db.prepare("INSERT INTO business_days (workspace_id, day_number, event_date, ticket_limit, sold_count) VALUES (?, 1, NULL, ?, 0), (?, 2, NULL, ?, 0), (?, 3, NULL, ?, 0)").bind(
      newId, context.maxTicketNumber, newId, context.maxTicketNumber, newId, context.maxTicketNumber,
    ),
    db.prepare("UPDATE system_state SET current_live_workspace_id = ?, mode_epoch = mode_epoch + 1, updated_at_ms = ? WHERE singleton_id = 1 AND mode = 'LIVE' AND mode_epoch = ? AND current_live_workspace_id = ? AND maintenance = 1").bind(
      newId, nowMs, request.modeEpoch, context.workspaceId,
    ),
    assertion(db, context, request.requestId, "live-reset", 1, nowMs),
    operation(db, newId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, newId, request.requestId, "LIVE_WORKSPACE_RESET", `本番運用回${nextSequence}を作成しました。`, nowMs),
  ]);
  return result;
}

async function renameDevice(db: D1Database, session: SessionContext, context: ActiveContext, request: MutationRequest, hash: string, nowMs: number) {
  ensureCurrent(context, request, true);
  const name = requireText(request.payload.name, "端末名", 100);
  const result = { name };
  await db.batch([
    db.prepare("UPDATE devices SET display_name = ?, last_seen_at_ms = ? WHERE id = ? AND disabled_at_ms IS NULL").bind(name, nowMs, session.deviceId),
    assertion(db, context, request.requestId, "device-renamed", 1, nowMs),
    operation(db, context.workspaceId, request.requestId, request.action, hash, result, nowMs),
    audit(db, session, context.workspaceId, request.requestId, "DEVICE_RENAMED", `端末名を「${name}」へ変更しました。`, nowMs),
  ]);
  return result;
}

export async function mutate(db: D1Database, session: SessionContext, request: MutationRequest): Promise<unknown> {
  ensureRequest(request);
  const hash = await sha256Hex(JSON.stringify({ action: request.action, payload: request.payload }));
  const previous = await existing(db, request.requestId, hash);
  if (previous !== null) return previous;
  const context = await activeContext(db);
  const nowMs = Date.now();
  try {
    switch (request.action) {
      case "CREATE_CHECKOUT": return await createCheckout(db, session, context, request, hash, nowMs);
      case "CANCEL_CHECKOUT": return await cancelCheckout(db, session, context, request, hash, nowMs);
      case "FINALIZE_SALE": return await finalizeSale(db, session, context, request, hash, nowMs);
      case "CHECKIN": return await checkin(db, session, context, request, hash, nowMs);
      case "HANDOVER_AND_CHECKIN": return await checkin(db, session, context, request, hash, nowMs, requireText(request.payload.saleId, "販売ID", 100));
      case "REVERSE_CHECKIN": return await reverseCheckin(db, session, context, request, hash, nowMs);
      case "REFUND": return await refund(db, session, context, request, hash, nowMs);
      case "CONFIRM_HANDOVER": return await confirmHandover(db, session, context, request, hash, nowMs);
      case "SET_MAINTENANCE": return await setMaintenance(db, session, context, request, hash, nowMs);
      case "ENABLE_DEVELOPER_MODE": return await enableDev(db, session, context, request, hash, nowMs);
      case "SET_DEVELOPER_DAY": return await setDevDay(db, session, context, request, hash, nowMs);
      case "DISABLE_DEVELOPER_MODE": return await disableDev(db, session, context, request, hash, nowMs);
      case "RESET_LIVE_WORKSPACE": return await resetLive(db, session, context, request, hash, nowMs);
      case "RENAME_DEVICE": return await renameDevice(db, session, context, request, hash, nowMs);
      default: throw new ApiError(400, "UNKNOWN_ACTION", "未対応の操作です。");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const text = error instanceof Error ? error.message : String(error);
    if (/transaction_assertions|CHECK constraint|UNIQUE constraint|FOREIGN KEY constraint|LIVE_/iu.test(text)) {
      throw new ApiError(409, "STATE_CONFLICT", "別の端末で状態が更新されました。最新状態を確認してください。");
    }
    throw error;
  }
}
