import { FASTPASS_CONFIG, type DayNumber } from "../config/fastpass.config";
import { FastpassError } from "./errors";
import { getJstDateString } from "./format";
import { createId, createWorkspace } from "./initialState";
import type {
  BusinessOperation,
  CashMovementType,
  Checkout,
  Expense,
  FastpassData,
  Refund,
  Sale,
  SaleResult,
  Summary,
  Ticket,
  TicketEvent,
  Workspace,
} from "./types";

const MAIN_CASHBOX_ID = "cashbox-main";

export type TicketPreview = {
  ticket: Ticket;
  sale: Sale;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hashRequest(value: unknown): string {
  return JSON.stringify(value);
}

function existingOperation<T>(
  data: FastpassData,
  workspaceId: string,
  operationId: string,
  requestHash: string,
): T | null {
  const existing = data.operations.find(
    (operation) => operation.workspaceId === workspaceId && operation.id === operationId,
  );
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new FastpassError(
      "IDEMPOTENCY_CONFLICT",
      "同じ操作IDが異なる内容で使われています。新しい操作としてやり直してください。",
    );
  }
  return clone(existing.result as T);
}

function commitOperation(
  data: FastpassData,
  workspaceId: string,
  operationId: string,
  type: string,
  requestHash: string,
  result: unknown,
  nowMs: number,
): void {
  const operation: BusinessOperation = {
    id: operationId,
    workspaceId,
    type,
    requestHash,
    result: clone(result),
    committedAtMs: nowMs,
  };
  data.operations.push(operation);
}

function addAudit(
  data: FastpassData,
  workspaceId: string | null,
  type: string,
  detail: string,
  nowMs: number,
  operationId: string | null = null,
): void {
  data.auditLogs.push({
    id: createId("audit"),
    workspaceId,
    type,
    status: "SUCCESS",
    occurredAtMs: nowMs,
    deviceId: data.system.device.id,
    operationId,
    detail,
  });
}

export function getActiveWorkspace(data: FastpassData): Workspace {
  const id =
    data.system.mode === "DEVELOPMENT"
      ? data.system.devWorkspaceId
      : data.system.liveWorkspaceId;
  const workspace = data.workspaces.find((candidate) => candidate.id === id);
  if (!workspace || workspace.status !== "ACTIVE") {
    throw new FastpassError("INVALID_SYSTEM_STATE", "有効な運用領域を確認できません。");
  }
  return workspace;
}

export function getLiveWorkspace(data: FastpassData): Workspace {
  const workspace = data.workspaces.find(
    (candidate) => candidate.id === data.system.liveWorkspaceId,
  );
  if (!workspace || workspace.status !== "ACTIVE") {
    throw new FastpassError("INVALID_SYSTEM_STATE", "現在の本番運用回を確認できません。");
  }
  return workspace;
}

function assertUpdatesAllowed(data: FastpassData): void {
  if (data.system.mode === "ENTERING_DEV" || data.system.mode === "PURGING_DEV") {
    throw new FastpassError("MODE_CHANGED", "モード切替中のため、業務操作を実行できません。");
  }
  if (data.system.maintenance) {
    throw new FastpassError("MAINTENANCE", "営業停止中です。管理画面から営業を再開してください。");
  }
}

export function expireHolds(data: FastpassData, nowMs = Date.now()): void {
  for (const checkout of data.checkouts) {
    if (checkout.status === "HELD" && checkout.expiresAtMs <= nowMs) {
      checkout.status = "EXPIRED";
    }
  }
}

function resolveDay(workspace: Workspace, nowMs: number): DayNumber {
  if (workspace.kind === "DEV") return workspace.selectedTestDay;
  const dates = ([1, 2, 3] as const).map((day) => workspace.businessDays[day].eventDate);
  if (dates.some((date) => date === null)) {
    throw new FastpassError(
      "EVENT_DATE_NOT_CONFIGURED",
      "開催日が未設定のため、本番販売を開始できません。開発者モードで確認してください。",
    );
  }
  const today = getJstDateString(nowMs);
  const dayIndex = dates.findIndex((date) => date === today);
  if (dayIndex < 0) {
    throw new FastpassError(
      "OUTSIDE_SALES_DATE",
      "本日は設定された開催日ではないため、本番販売を開始できません。",
    );
  }
  return (dayIndex + 1) as DayNumber;
}

export function getDisplayDay(workspace: Workspace, nowMs = Date.now()): DayNumber {
  if (workspace.kind === "DEV") return workspace.selectedTestDay;
  const today = getJstDateString(nowMs);
  const found = ([1, 2, 3] as const).find(
    (day) => workspace.businessDays[day].eventDate === today,
  );
  return found ?? 1;
}

function activeHoldQuantity(
  data: FastpassData,
  workspaceId: string,
  nowMs: number,
  dayNumber?: DayNumber,
  excludingCheckoutId?: string,
): number {
  return data.checkouts
    .filter(
      (checkout) =>
        checkout.workspaceId === workspaceId &&
        checkout.status === "HELD" &&
        checkout.expiresAtMs > nowMs &&
        checkout.id !== excludingCheckoutId &&
        (dayNumber === undefined || checkout.dayNumber === dayNumber),
    )
    .reduce((sum, checkout) => sum + checkout.quantity, 0);
}

export function getSummary(data: FastpassData, nowMs = Date.now()): Summary {
  expireHolds(data, nowMs);
  const workspace = getActiveWorkspace(data);
  const dayNumber = getDisplayDay(workspace, nowMs);
  const workspaceSales = data.sales.filter((sale) => sale.workspaceId === workspace.id);
  const workspaceRefunds = data.refunds.filter((refund) => refund.workspaceId === workspace.id);
  const workspaceTickets = data.tickets.filter((ticket) => ticket.workspaceId === workspace.id);
  const activeHolds = activeHoldQuantity(data, workspace.id, nowMs, dayNumber);
  const day = workspace.businessDays[dayNumber];
  const limitsEnforced = workspace.kind === "LIVE";
  const totalActiveHolds = activeHoldQuantity(data, workspace.id, nowMs);
  const totalTenderedYen = workspaceSales.reduce((sum, sale) => sum + sale.tenderedYen, 0);
  const totalChangeYen = workspaceSales.reduce((sum, sale) => sum + sale.changeYen, 0);
  const finalProfitYen = totalTenderedYen - totalChangeYen;
  const refundsYen = workspaceRefunds.reduce((sum, refund) => sum + refund.totalYen, 0);
  return {
    dayNumber,
    soldToday: day.soldCount,
    dailyLimit: limitsEnforced ? day.ticketLimit : null,
    activeHolds,
    availableToday: limitsEnforced
      ? Math.max(
          0,
          Math.min(
            day.ticketLimit - day.soldCount - activeHolds,
            workspace.configSnapshot.MAX_TICKET_NUMBER -
              workspace.lastTicketNumber -
              totalActiveHolds,
          ),
        )
      : null,
    totalSold: workspaceTickets.length,
    totalRefunded: workspaceTickets.filter((ticket) => ticket.status === "REFUNDED").length,
    issuedCount: workspaceTickets.filter((ticket) => ticket.status === "ISSUED").length,
    usedCount: workspaceTickets.filter((ticket) => ticket.status === "USED").length,
    unissuedCount: limitsEnforced
      ? Math.max(0, workspace.configSnapshot.MAX_TICKET_NUMBER - workspace.lastTicketNumber)
      : null,
    checkoutCount: workspaceSales.length,
    totalTenderedYen,
    totalChangeYen,
    finalProfitYen,
    grossSalesYen: workspaceSales.reduce((sum, sale) => sum + sale.totalYen, 0),
    refundsYen,
    netSalesYen: finalProfitYen - refundsYen,
    expectedCashYen: data.cashLedger
      .filter((entry) => entry.workspaceId === workspace.id)
      .reduce((sum, entry) => sum + entry.amountYen, 0),
  };
}

export function createCheckout(
  data: FastpassData,
  quantity: number,
  operationId: string,
  nowMs = Date.now(),
): Checkout {
  assertUpdatesAllowed(data);
  expireHolds(data, nowMs);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CREATE_CHECKOUT", quantity });
  const previous = existingOperation<Checkout>(data, workspace.id, operationId, requestHash);
  if (previous) return previous;
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > workspace.configSnapshot.MAX_ITEMS_PER_OPERATION
  ) {
    throw new FastpassError(
      "INVALID_INPUT",
      `人数は1～${workspace.configSnapshot.MAX_ITEMS_PER_OPERATION}の整数で入力してください。`,
    );
  }
  const dayNumber = resolveDay(workspace, nowMs);
  if (workspace.kind === "LIVE") {
    const day = workspace.businessDays[dayNumber];
    const dayAvailable =
      day.ticketLimit -
      day.soldCount -
      activeHoldQuantity(data, workspace.id, nowMs, dayNumber);
    const numberAvailable =
      workspace.configSnapshot.MAX_TICKET_NUMBER -
      workspace.lastTicketNumber -
      activeHoldQuantity(data, workspace.id, nowMs);
    if (dayAvailable <= 0) {
      throw new FastpassError("DAILY_LIMIT_REACHED", "本日の販売上限に達しています。");
    }
    if (numberAvailable <= 0) {
      throw new FastpassError("NUMBER_LIMIT_REACHED", "本番の発行可能番号を使い切りました。");
    }
    if (quantity > Math.min(dayAvailable, numberAvailable)) {
      throw new FastpassError(
        "INSUFFICIENT_CAPACITY",
        `残り${Math.max(0, Math.min(dayAvailable, numberAvailable))}枚のため、この人数をまとめて確保できません。`,
      );
    }
  }
  const checkout: Checkout = {
    id: createId("checkout"),
    workspaceId: workspace.id,
    dayNumber,
    quantity,
    unitPriceYen: workspace.configSnapshot.UNIT_PRICE_YEN,
    status: "HELD",
    createdAtMs: nowMs,
    expiresAtMs: Math.min(
      nowMs + workspace.configSnapshot.CHECKOUT_HOLD_SECONDS * 1000,
      endOfJstDay(nowMs),
    ),
    deviceId: data.system.device.id,
    cashboxId: getCashbox(data, workspace.id).id,
  };
  data.checkouts.push(checkout);
  commitOperation(data, workspace.id, operationId, "CREATE_CHECKOUT", requestHash, checkout, nowMs);
  addAudit(
    data,
    workspace.id,
    "CHECKOUT_HELD",
    `${quantity}枚を一時確保しました。`,
    nowMs,
    operationId,
  );
  return clone(checkout);
}

function endOfJstDay(nowMs: number): number {
  const jstDate = getJstDateString(nowMs);
  return Date.parse(`${jstDate}T23:59:59.999+09:00`);
}

export function cancelCheckout(
  data: FastpassData,
  checkoutId: string,
  operationId: string,
  nowMs = Date.now(),
): Checkout {
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CANCEL_CHECKOUT", checkoutId });
  const previous = existingOperation<Checkout>(data, workspace.id, operationId, requestHash);
  if (previous) return previous;
  const checkout = data.checkouts.find(
    (candidate) => candidate.id === checkoutId && candidate.workspaceId === workspace.id,
  );
  if (!checkout || checkout.status !== "HELD") {
    throw new FastpassError("HOLD_EXPIRED", "この一時確保は取り消せる状態ではありません。");
  }
  checkout.status = "CANCELLED";
  commitOperation(data, workspace.id, operationId, "CANCEL_CHECKOUT", requestHash, checkout, nowMs);
  addAudit(data, workspace.id, "CHECKOUT_CANCELLED", "一時確保を解除しました。", nowMs, operationId);
  return clone(checkout);
}

export function finalizeSale(
  data: FastpassData,
  checkoutId: string,
  tenderedYen: number,
  operationId: string,
  nowMs = Date.now(),
): SaleResult {
  assertUpdatesAllowed(data);
  expireHolds(data, nowMs);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "FINALIZE_SALE", checkoutId, tenderedYen });
  const previous = existingOperation<SaleResult>(data, workspace.id, operationId, requestHash);
  if (previous) return previous;
  const checkout = data.checkouts.find(
    (candidate) => candidate.id === checkoutId && candidate.workspaceId === workspace.id,
  );
  if (!checkout || checkout.status !== "HELD" || checkout.expiresAtMs <= nowMs) {
    throw new FastpassError("HOLD_EXPIRED", "一時確保の期限が切れました。人数入力からやり直してください。");
  }
  const dayNumber = resolveDay(workspace, nowMs);
  if (dayNumber !== checkout.dayNumber) {
    throw new FastpassError("HOLD_EXPIRED", "日付またはテスト日が変わったため、一時確保を確定できません。");
  }
  const totalYen = checkout.quantity * checkout.unitPriceYen;
  if (
    !Number.isSafeInteger(tenderedYen) ||
    tenderedYen < totalYen ||
    tenderedYen > workspace.configSnapshot.MAX_TENDERED_YEN
  ) {
    throw new FastpassError(
      "INVALID_INPUT",
      tenderedYen < totalYen
        ? `預り金が${totalYen - tenderedYen}円不足しています。`
        : `預り金は${workspace.configSnapshot.MAX_TENDERED_YEN}円以下で入力してください。`,
    );
  }
  if (workspace.kind === "LIVE") {
    const day = workspace.businessDays[dayNumber];
    if (day.soldCount + checkout.quantity > day.ticketLimit) {
      throw new FastpassError("DAILY_LIMIT_REACHED", "確定時点で本日の販売上限を超えます。");
    }
    if (
      workspace.lastTicketNumber + checkout.quantity >
      workspace.configSnapshot.MAX_TICKET_NUMBER
    ) {
      throw new FastpassError("NUMBER_LIMIT_REACHED", "確定時点で本番の番号上限を超えます。");
    }
  }
  const groupNumber = workspace.lastGroupNumber + 1;
  const ticketNumbers = Array.from(
    { length: checkout.quantity },
    (_, index) => workspace.lastTicketNumber + index + 1,
  );
  const saleId = createId("sale");
  const ticketIds = ticketNumbers.map(() => createId("ticket"));
  const sale: Sale = {
    id: saleId,
    workspaceId: workspace.id,
    checkoutId: checkout.id,
    groupNumber,
    dayNumber,
    quantity: checkout.quantity,
    unitPriceYen: checkout.unitPriceYen,
    totalYen,
    tenderedYen,
    changeYen: tenderedYen - totalYen,
    purchasedAtMs: nowMs,
    deviceId: data.system.device.id,
    cashboxId: checkout.cashboxId,
    ticketIds,
    ticketNumbers,
    handoverConfirmedAtMs: null,
  };
  data.sales.push(sale);
  ticketNumbers.forEach((serialNumber, index) => {
    const ticket: Ticket = {
      id: ticketIds[index],
      workspaceId: workspace.id,
      serialNumber,
      saleId,
      status: "ISSUED",
      usedAtMs: null,
      currentUseEventId: null,
      refundedAtMs: null,
      version: 0,
    };
    data.tickets.push(ticket);
    data.ticketEvents.push({
      id: createId("ticket-event"),
      workspaceId: workspace.id,
      ticketId: ticket.id,
      type: "SALE",
      fromStatus: "UNISSUED",
      toStatus: "ISSUED",
      occurredAtMs: nowMs,
      deviceId: data.system.device.id,
      operationId,
      reason: null,
      reversedEventId: null,
    });
  });
  checkout.status = "COMPLETED";
  workspace.lastTicketNumber += checkout.quantity;
  workspace.lastGroupNumber = groupNumber;
  workspace.businessDays[dayNumber].soldCount += checkout.quantity;
  data.cashLedger.push({
    id: createId("ledger"),
    workspaceId: workspace.id,
    cashboxId: checkout.cashboxId,
    type: "SALE",
    amountYen: totalYen,
    occurredAtMs: nowMs,
    dayNumber,
    sourceType: "SALE",
    sourceId: saleId,
    reason: null,
    reversedEntryId: null,
    deviceId: data.system.device.id,
  });
  const result: SaleResult = {
    saleId,
    checkoutId,
    groupNumber,
    ticketNumbers,
    totalYen,
    tenderedYen,
    changeYen: tenderedYen - totalYen,
    purchasedAtMs: nowMs,
  };
  commitOperation(data, workspace.id, operationId, "FINALIZE_SALE", requestHash, result, nowMs);
  addAudit(
    data,
    workspace.id,
    "SALE_COMMITTED",
    `${checkout.quantity}枚を販売し、グループ${groupNumber}を発番しました。`,
    nowMs,
    operationId,
  );
  return clone(result);
}

export function confirmHandover(
  data: FastpassData,
  kind: "SALE" | "REFUND",
  sourceId: string,
  operationId: string,
  nowMs = Date.now(),
): void {
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CONFIRM_HANDOVER", kind, sourceId });
  const previous = existingOperation<{ confirmed: true }>(
    data,
    workspace.id,
    operationId,
    requestHash,
  );
  if (previous) return;
  if (kind === "SALE") {
    const sale = data.sales.find(
      (candidate) => candidate.id === sourceId && candidate.workspaceId === workspace.id,
    );
    if (!sale) throw new FastpassError("INVALID_INPUT", "販売記録が見つかりません。");
    sale.handoverConfirmedAtMs ??= nowMs;
  } else {
    const refund = data.refunds.find(
      (candidate) => candidate.id === sourceId && candidate.workspaceId === workspace.id,
    );
    if (!refund) throw new FastpassError("INVALID_INPUT", "払い戻し記録が見つかりません。");
    refund.handoverConfirmedAtMs ??= nowMs;
  }
  commitOperation(
    data,
    workspace.id,
    operationId,
    "CONFIRM_HANDOVER",
    requestHash,
    { confirmed: true },
    nowMs,
  );
  addAudit(data, workspace.id, `${kind}_HANDOVER_CONFIRMED`, "受渡しを確認しました。", nowMs, operationId);
}

export function previewTickets(data: FastpassData, serialNumbers: number[]): TicketPreview[] {
  const workspace = getActiveWorkspace(data);
  const unique = new Set(serialNumbers);
  if (unique.size !== serialNumbers.length || serialNumbers.length === 0) {
    throw new FastpassError("INVALID_INPUT", "番号が空、または一覧内で重複しています。");
  }
  return serialNumbers.map((serialNumber) => {
    if (!Number.isSafeInteger(serialNumber) || serialNumber < 1) {
      throw new FastpassError("INVALID_INPUT", "チケット番号は1以上の整数で入力してください。");
    }
    if (
      workspace.kind === "LIVE" &&
      serialNumber > workspace.configSnapshot.MAX_TICKET_NUMBER
    ) {
      throw new FastpassError("INVALID_INPUT", "本番の最大番号を超えています。");
    }
    const ticket = data.tickets.find(
      (candidate) =>
        candidate.workspaceId === workspace.id && candidate.serialNumber === serialNumber,
    );
    if (!ticket) {
      throw new FastpassError("TICKET_NOT_FOUND", `番号${serialNumber}は販売されていません。`);
    }
    const sale = data.sales.find(
      (candidate) => candidate.workspaceId === workspace.id && candidate.id === ticket.saleId,
    );
    if (!sale) throw new FastpassError("INVALID_SYSTEM_STATE", "元の販売記録を確認できません。");
    return { ticket: clone(ticket), sale: clone(sale) };
  });
}

export function checkInTickets(
  data: FastpassData,
  serialNumbers: number[],
  operationId: string,
  nowMs = Date.now(),
): { admissionId: string; ticketNumbers: number[] } {
  assertUpdatesAllowed(data);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CHECKIN", serialNumbers: [...serialNumbers].sort((a, b) => a - b) });
  const previous = existingOperation<{ admissionId: string; ticketNumbers: number[] }>(
    data,
    workspace.id,
    operationId,
    requestHash,
  );
  if (previous) return previous;
  const previews = previewTickets(data, serialNumbers);
  const invalid = previews.filter(({ ticket }) => ticket.status !== "ISSUED");
  if (invalid.length > 0) {
    throw new FastpassError(
      "TICKET_STATE_CONFLICT",
      "未使用の販売済み券だけを入場確定できます。全件を未確定のまま維持しました。",
      invalid.map(({ ticket }) => `${ticket.serialNumber}:${ticket.status}`),
    );
  }
  const admissionId = createId("admission");
  const ticketIds: string[] = [];
  previews.forEach(({ ticket: preview }) => {
    const ticket = data.tickets.find((candidate) => candidate.id === preview.id)!;
    const eventId = createId("ticket-event");
    ticket.status = "USED";
    ticket.usedAtMs = nowMs;
    ticket.currentUseEventId = eventId;
    ticket.version += 1;
    ticketIds.push(ticket.id);
    data.ticketEvents.push({
      id: eventId,
      workspaceId: workspace.id,
      ticketId: ticket.id,
      type: "CHECKIN",
      fromStatus: "ISSUED",
      toStatus: "USED",
      occurredAtMs: nowMs,
      deviceId: data.system.device.id,
      operationId,
      reason: null,
      reversedEventId: null,
    });
  });
  data.admissions.push({
    id: admissionId,
    workspaceId: workspace.id,
    ticketIds,
    operationId,
    occurredAtMs: nowMs,
    deviceId: data.system.device.id,
  });
  const result = { admissionId, ticketNumbers: [...serialNumbers] };
  commitOperation(data, workspace.id, operationId, "CHECKIN", requestHash, result, nowMs);
  addAudit(data, workspace.id, "CHECKIN_COMMITTED", `${ticketIds.length}枚の入場を確定しました。`, nowMs, operationId);
  return result;
}

export function reverseCheckin(
  data: FastpassData,
  serialNumber: number,
  reason: string,
  expectedUseEventId: string,
  operationId: string,
  nowMs = Date.now(),
): void {
  assertUpdatesAllowed(data);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "REVERSE_CHECKIN", serialNumber, reason, expectedUseEventId });
  const previous = existingOperation<{ reversed: true }>(
    data,
    workspace.id,
    operationId,
    requestHash,
  );
  if (previous) return;
  const [{ ticket: preview }] = previewTickets(data, [serialNumber]);
  const ticket = data.tickets.find((candidate) => candidate.id === preview.id)!;
  if (ticket.status !== "USED" || ticket.currentUseEventId !== expectedUseEventId) {
    throw new FastpassError(
      "TICKET_STATE_CONFLICT",
      "現在有効な使用登録が変わっています。新しい使用登録は取り消していません。",
    );
  }
  const eventId = createId("ticket-event");
  const useEventId = ticket.currentUseEventId;
  ticket.status = "ISSUED";
  ticket.usedAtMs = null;
  ticket.currentUseEventId = null;
  ticket.version += 1;
  const event: TicketEvent = {
    id: eventId,
    workspaceId: workspace.id,
    ticketId: ticket.id,
    type: "CHECKIN_REVERSAL",
    fromStatus: "USED",
    toStatus: "ISSUED",
    occurredAtMs: nowMs,
    deviceId: data.system.device.id,
    operationId,
    reason,
    reversedEventId: useEventId,
  };
  data.ticketEvents.push(event);
  data.checkinReversals.push({
    id: createId("checkin-reversal"),
    workspaceId: workspace.id,
    ticketId: ticket.id,
    useEventId,
    reason,
    operationId,
    occurredAtMs: nowMs,
    deviceId: data.system.device.id,
  });
  commitOperation(data, workspace.id, operationId, "REVERSE_CHECKIN", requestHash, { reversed: true }, nowMs);
  addAudit(data, workspace.id, "CHECKIN_REVERSED", `番号${serialNumber}の使用済みを取り消しました。`, nowMs, operationId);
}

export function refundTickets(
  data: FastpassData,
  serialNumbers: number[],
  reason: string,
  operationId: string,
  nowMs = Date.now(),
): Refund {
  assertUpdatesAllowed(data);
  const workspace = getActiveWorkspace(data);
  const normalizedNumbers = [...serialNumbers].sort((a, b) => a - b);
  const requestHash = hashRequest({ type: "REFUND", serialNumbers: normalizedNumbers, reason });
  const previous = existingOperation<Refund>(data, workspace.id, operationId, requestHash);
  if (previous) return previous;
  const previews = previewTickets(data, serialNumbers);
  const invalid = previews.filter(({ ticket }) => ticket.status !== "ISSUED");
  if (invalid.length > 0) {
    throw new FastpassError(
      "TICKET_STATE_CONFLICT",
      "未使用の販売済み券だけを払い戻しできます。全件を未確定のまま維持しました。",
      invalid.map(({ ticket }) => `${ticket.serialNumber}:${ticket.status}`),
    );
  }
  const refundAmountsYen = previews.map(({ sale }) => sale.unitPriceYen);
  const totalYen = refundAmountsYen.reduce((sum, amount) => sum + amount, 0);
  const refund: Refund = {
    id: createId("refund"),
    workspaceId: workspace.id,
    ticketIds: previews.map(({ ticket }) => ticket.id),
    refundAmountsYen,
    totalYen,
    reason,
    operationId,
    occurredAtMs: nowMs,
    deviceId: data.system.device.id,
    cashboxId: getCashbox(data, workspace.id).id,
    handoverConfirmedAtMs: null,
  };
  previews.forEach(({ ticket: preview }) => {
    const ticket = data.tickets.find((candidate) => candidate.id === preview.id)!;
    ticket.status = "REFUNDED";
    ticket.refundedAtMs = nowMs;
    ticket.version += 1;
    data.ticketEvents.push({
      id: createId("ticket-event"),
      workspaceId: workspace.id,
      ticketId: ticket.id,
      type: "REFUND",
      fromStatus: "ISSUED",
      toStatus: "REFUNDED",
      occurredAtMs: nowMs,
      deviceId: data.system.device.id,
      operationId,
      reason,
      reversedEventId: null,
    });
  });
  data.refunds.push(refund);
  data.cashLedger.push({
    id: createId("ledger"),
    workspaceId: workspace.id,
    cashboxId: refund.cashboxId,
    type: "REFUND",
    amountYen: -totalYen,
    occurredAtMs: nowMs,
    dayNumber: getDisplayDay(workspace, nowMs),
    sourceType: "REFUND",
    sourceId: refund.id,
    reason,
    reversedEntryId: null,
    deviceId: data.system.device.id,
  });
  commitOperation(data, workspace.id, operationId, "REFUND", requestHash, refund, nowMs);
  addAudit(data, workspace.id, "REFUND_COMMITTED", `${previews.length}枚、${totalYen}円を払い戻しました。`, nowMs, operationId);
  return clone(refund);
}

function getCashbox(data: FastpassData, workspaceId: string) {
  let cashbox = data.cashboxes.find((candidate) => candidate.workspaceId === workspaceId);
  if (!cashbox) {
    cashbox = { id: `${MAIN_CASHBOX_ID}-${workspaceId}`, workspaceId, name: "共通レジ" };
    data.cashboxes.push(cashbox);
  }
  return cashbox;
}

export function addCashMovement(
  data: FastpassData,
  type: Exclude<CashMovementType, "SALE" | "REFUND" | "EXPENSE" | "REVERSAL">,
  amountYen: number,
  reason: string,
  operationId: string,
  nowMs = Date.now(),
): void {
  assertUpdatesAllowed(data);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CASH_MOVEMENT", movementType: type, amountYen, reason });
  const previous = existingOperation<{ recorded: true }>(data, workspace.id, operationId, requestHash);
  if (previous) return;
  if (!Number.isSafeInteger(amountYen) || amountYen < 1 || amountYen > FASTPASS_CONFIG.MAX_TENDERED_YEN) {
    throw new FastpassError("INVALID_INPUT", "金額は1円以上の有効な整数で入力してください。");
  }
  const signedAmount = type === "COLLECTION" ? -amountYen : amountYen;
  data.cashLedger.push({
    id: createId("ledger"),
    workspaceId: workspace.id,
    cashboxId: getCashbox(data, workspace.id).id,
    type,
    amountYen: signedAmount,
    occurredAtMs: nowMs,
    dayNumber: getDisplayDay(workspace, nowMs),
    sourceType: "CASH_MOVEMENT",
    sourceId: operationId,
    reason,
    reversedEntryId: null,
    deviceId: data.system.device.id,
  });
  commitOperation(data, workspace.id, operationId, "CASH_MOVEMENT", requestHash, { recorded: true }, nowMs);
  addAudit(data, workspace.id, "CASH_MOVEMENT_RECORDED", `${type} ${signedAmount}円を記録しました。`, nowMs, operationId);
}

export function addExpense(
  data: FastpassData,
  amountYen: number,
  category: string,
  paymentSource: "CASHBOX" | "OUTSIDE",
  reason: string,
  operationId: string,
  nowMs = Date.now(),
): Expense {
  assertUpdatesAllowed(data);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "EXPENSE", amountYen, category, paymentSource, reason });
  const previous = existingOperation<Expense>(data, workspace.id, operationId, requestHash);
  if (previous) return previous;
  if (!Number.isSafeInteger(amountYen) || amountYen < 1) {
    throw new FastpassError("INVALID_INPUT", "経費は1円以上の整数で入力してください。");
  }
  const cashbox = getCashbox(data, workspace.id);
  const expense: Expense = {
    id: createId("expense"),
    workspaceId: workspace.id,
    amountYen,
    category,
    paymentSource,
    occurredAtMs: nowMs,
    dayNumber: getDisplayDay(workspace, nowMs),
    reason,
    ledgerEntryId: null,
    cancelledAtMs: null,
    deviceId: data.system.device.id,
  };
  if (paymentSource === "CASHBOX") {
    const ledgerId = createId("ledger");
    expense.ledgerEntryId = ledgerId;
    data.cashLedger.push({
      id: ledgerId,
      workspaceId: workspace.id,
      cashboxId: cashbox.id,
      type: "EXPENSE",
      amountYen: -amountYen,
      occurredAtMs: nowMs,
      dayNumber: expense.dayNumber,
      sourceType: "EXPENSE",
      sourceId: expense.id,
      reason,
      reversedEntryId: null,
      deviceId: data.system.device.id,
    });
  }
  data.expenses.push(expense);
  workspace.expensesConfirmedAtMs = null;
  commitOperation(data, workspace.id, operationId, "EXPENSE", requestHash, expense, nowMs);
  addAudit(data, workspace.id, "EXPENSE_RECORDED", `${category} ${amountYen}円を記録しました。`, nowMs, operationId);
  return clone(expense);
}

export function cancelExpense(
  data: FastpassData,
  expenseId: string,
  reason: string,
  operationId: string,
  nowMs = Date.now(),
): void {
  assertUpdatesAllowed(data);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CANCEL_EXPENSE", expenseId, reason });
  const previous = existingOperation<{ cancelled: true }>(data, workspace.id, operationId, requestHash);
  if (previous) return;
  const expense = data.expenses.find(
    (candidate) => candidate.id === expenseId && candidate.workspaceId === workspace.id,
  );
  if (!expense || expense.cancelledAtMs !== null) {
    throw new FastpassError("INVALID_INPUT", "取り消せる経費記録が見つかりません。");
  }
  expense.cancelledAtMs = nowMs;
  if (expense.ledgerEntryId) {
    const original = data.cashLedger.find((entry) => entry.id === expense.ledgerEntryId);
    if (!original) throw new FastpassError("INVALID_SYSTEM_STATE", "経費の現金台帳を確認できません。");
    data.cashLedger.push({
      ...clone(original),
      id: createId("ledger"),
      type: "REVERSAL",
      amountYen: -original.amountYen,
      occurredAtMs: nowMs,
      sourceType: "EXPENSE_REVERSAL",
      sourceId: expense.id,
      reason,
      reversedEntryId: original.id,
    });
  }
  workspace.expensesConfirmedAtMs = null;
  commitOperation(data, workspace.id, operationId, "CANCEL_EXPENSE", requestHash, { cancelled: true }, nowMs);
  addAudit(data, workspace.id, "EXPENSE_CANCELLED", `${expense.amountYen}円の経費記録を取り消しました。`, nowMs, operationId);
}

export function addCashCount(
  data: FastpassData,
  actualYen: number,
  operationId: string,
  nowMs = Date.now(),
): void {
  assertUpdatesAllowed(data);
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CASH_COUNT", actualYen });
  const previous = existingOperation<{ recorded: true }>(data, workspace.id, operationId, requestHash);
  if (previous) return;
  if (!Number.isSafeInteger(actualYen) || actualYen < 0) {
    throw new FastpassError("INVALID_INPUT", "実査額は0円以上の整数で入力してください。");
  }
  const expectedYen = data.cashLedger
    .filter((entry) => entry.workspaceId === workspace.id)
    .reduce((sum, entry) => sum + entry.amountYen, 0);
  data.cashCounts.push({
    id: createId("cash-count"),
    workspaceId: workspace.id,
    cashboxId: getCashbox(data, workspace.id).id,
    actualYen,
    expectedYen,
    differenceYen: actualYen - expectedYen,
    occurredAtMs: nowMs,
    deviceId: data.system.device.id,
  });
  commitOperation(data, workspace.id, operationId, "CASH_COUNT", requestHash, { recorded: true }, nowMs);
  addAudit(data, workspace.id, "CASH_COUNT_RECORDED", `実査額${actualYen}円を記録しました。`, nowMs, operationId);
}

export function confirmExpenses(
  data: FastpassData,
  operationId: string,
  nowMs = Date.now(),
): void {
  const workspace = getActiveWorkspace(data);
  const requestHash = hashRequest({ type: "CONFIRM_EXPENSES" });
  const previous = existingOperation<{ confirmed: true }>(data, workspace.id, operationId, requestHash);
  if (previous) return;
  workspace.expensesConfirmedAtMs = nowMs;
  commitOperation(data, workspace.id, operationId, "CONFIRM_EXPENSES", requestHash, { confirmed: true }, nowMs);
  addAudit(data, workspace.id, "EXPENSES_CONFIRMED", "経費を確認済みにしました。", nowMs, operationId);
}

export function setMaintenance(
  data: FastpassData,
  maintenance: boolean,
  nowMs = Date.now(),
): void {
  if (data.system.mode === "ENTERING_DEV" || data.system.mode === "PURGING_DEV") {
    throw new FastpassError("MODE_CHANGED", "モード切替中は営業状態を変更できません。");
  }
  data.system.maintenance = maintenance;
  data.system.modeEpoch += 1;
  addAudit(
    data,
    getActiveWorkspace(data).id,
    maintenance ? "MAINTENANCE_ENABLED" : "MAINTENANCE_DISABLED",
    maintenance ? "営業を停止しました。" : "営業を再開しました。",
    nowMs,
  );
}

function assertNoPendingPhysicalOperations(data: FastpassData, workspaceId: string): void {
  const pendingSales = data.sales.some(
    (sale) => sale.workspaceId === workspaceId && sale.handoverConfirmedAtMs === null,
  );
  const pendingRefunds = data.refunds.some(
    (refund) => refund.workspaceId === workspaceId && refund.handoverConfirmedAtMs === null,
  );
  if (pendingSales || pendingRefunds) {
    throw new FastpassError(
      "PENDING_HANDOVER_EXISTS",
      "券・釣銭・返金の受渡未確認があります。記録画面で解消してください。",
    );
  }
}

export function enableDeveloperMode(data: FastpassData, nowMs = Date.now()): void {
  if (!FASTPASS_CONFIG.ALLOW_DEVELOPER_MODE || data.system.mode !== "LIVE") {
    throw new FastpassError("MODE_CHANGED", "現在の状態では開発者モードを開始できません。");
  }
  const live = getLiveWorkspace(data);
  assertNoPendingPhysicalOperations(data, live.id);
  data.system.maintenance = true;
  data.system.mode = "ENTERING_DEV";
  data.system.modeEpoch += 1;
  expireHolds(data, nowMs);
  data.checkouts.forEach((checkout) => {
    if (checkout.workspaceId === live.id && checkout.status === "HELD") checkout.status = "CANCELLED";
  });
  const nextDevSequence =
    data.workspaces.filter((workspace) => workspace.kind === "DEV").reduce((max, workspace) => Math.max(max, workspace.sequence), 0) + 1;
  const dev = createWorkspace("DEV", nextDevSequence, nowMs);
  data.workspaces.push(dev);
  data.cashboxes.push({ id: `${MAIN_CASHBOX_ID}-${dev.id}`, workspaceId: dev.id, name: "テスト共通レジ" });
  data.system.devWorkspaceId = dev.id;
  data.system.mode = "DEVELOPMENT";
  data.system.maintenance = false;
  addAudit(data, null, "DEVELOPER_MODE_ENABLED", "新しいDEV領域を作成しました。", nowMs);
}

export function setDeveloperDay(data: FastpassData, dayNumber: DayNumber, nowMs = Date.now()): void {
  if (data.system.mode !== "DEVELOPMENT") {
    throw new FastpassError("MODE_CHANGED", "開発者モードではありません。");
  }
  const workspace = getActiveWorkspace(data);
  const held = data.checkouts.some(
    (checkout) => checkout.workspaceId === workspace.id && checkout.status === "HELD" && checkout.expiresAtMs > nowMs,
  );
  if (held) throw new FastpassError("HOLD_EXPIRED", "一時確保中はテスト日を変更できません。");
  workspace.selectedTestDay = dayNumber;
  data.system.modeEpoch += 1;
  addAudit(data, workspace.id, "DEVELOPER_DAY_CHANGED", `テスト日を${dayNumber}日目に変更しました。`, nowMs);
}

const WORKSPACE_ARRAY_KEYS = [
  "checkouts",
  "sales",
  "tickets",
  "ticketEvents",
  "admissions",
  "checkinReversals",
  "refunds",
  "cashboxes",
  "cashLedger",
  "expenses",
  "cashCounts",
  "operations",
] as const;

export function disableDeveloperMode(data: FastpassData, nowMs = Date.now()): void {
  if (data.system.mode !== "DEVELOPMENT" || !data.system.devWorkspaceId) {
    throw new FastpassError("MODE_CHANGED", "削除対象の開発者モード領域がありません。");
  }
  const devId = data.system.devWorkspaceId;
  assertNoPendingPhysicalOperations(data, devId);
  data.system.mode = "PURGING_DEV";
  data.system.maintenance = true;
  data.system.modeEpoch += 1;
  for (const key of WORKSPACE_ARRAY_KEYS) {
    const rows = data[key] as Array<{ workspaceId: string }>;
    (data[key] as Array<{ workspaceId: string }>) = rows.filter((row) => row.workspaceId !== devId);
  }
  data.auditLogs = data.auditLogs.filter((row) => row.workspaceId !== devId);
  data.workspaces = data.workspaces.filter((workspace) => workspace.id !== devId);
  const remaining = WORKSPACE_ARRAY_KEYS.some((key) =>
    (data[key] as Array<{ workspaceId: string }>).some((row) => row.workspaceId === devId),
  );
  if (remaining) {
    throw new FastpassError("INVALID_SYSTEM_STATE", "DEV領域の削除確認に失敗しました。営業停止を維持します。");
  }
  data.system.devWorkspaceId = null;
  data.system.mode = "LIVE";
  addAudit(data, null, "DEVELOPER_MODE_PURGED", "DEV領域を削除し、LIVEの営業停止状態へ戻りました。", nowMs);
}

export function resetLiveWorkspace(data: FastpassData, nowMs = Date.now()): void {
  if (data.system.mode !== "LIVE" || !data.system.maintenance) {
    throw new FastpassError("MAINTENANCE", "本番リセットにはLIVEの営業停止が必要です。");
  }
  const current = getLiveWorkspace(data);
  assertNoPendingPhysicalOperations(data, current.id);
  const salesCount = data.sales.filter((sale) => sale.workspaceId === current.id).length;
  const configuredDates = ([1, 2, 3] as const).map((day) => current.businessDays[day].eventDate);
  if (salesCount > 0) {
    if (configuredDates.some((date) => date === null)) {
      throw new FastpassError(
        "INVALID_SYSTEM_STATE",
        "販売実績があり開催日未設定のため、安全に開催終了を確認できません。ローカル画面からはリセットできません。",
      );
    }
    const finalDate = configuredDates[2] as string;
    if (getJstDateString(nowMs) <= finalDate) {
      throw new FastpassError("INVALID_SYSTEM_STATE", "最終開催日が終了するまで本番リセットできません。");
    }
  }
  current.status = "ARCHIVED";
  current.endedAtMs = nowMs;
  const next = createWorkspace("LIVE", current.sequence + 1, nowMs);
  data.workspaces.push(next);
  data.cashboxes.push({ id: `${MAIN_CASHBOX_ID}-${next.id}`, workspaceId: next.id, name: "共通レジ" });
  data.system.liveWorkspaceId = next.id;
  data.system.modeEpoch += 1;
  data.system.maintenance = true;
  addAudit(data, null, "LIVE_WORKSPACE_RESET", `本番運用回${current.sequence}を保存し、運用回${next.sequence}を作成しました。`, nowMs);
}

export function renameDevice(data: FastpassData, name: string, nowMs = Date.now()): void {
  const normalized = name.trim();
  if (!normalized || normalized.length > 30) {
    throw new FastpassError("INVALID_INPUT", "端末名は1～30文字で入力してください。");
  }
  data.system.device.name = normalized;
  addAudit(data, null, "DEVICE_RENAMED", `端末名を「${normalized}」に変更しました。`, nowMs);
}
