import { FASTPASS_CONFIG } from "../config/fastpass.config";
import type { DayNumber } from "../config/fastpass.config";
import type { BusinessDayState, FastpassData, Workspace } from "./types";

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function cloneConfig() {
  return structuredClone(FASTPASS_CONFIG);
}

function createBusinessDays(): Record<DayNumber, BusinessDayState> {
  return {
    1: {
      dayNumber: 1,
      eventDate: FASTPASS_CONFIG.EVENT_DATES[1],
      ticketLimit: FASTPASS_CONFIG.DAILY_TICKET_LIMITS[1],
      soldCount: 0,
    },
    2: {
      dayNumber: 2,
      eventDate: FASTPASS_CONFIG.EVENT_DATES[2],
      ticketLimit: FASTPASS_CONFIG.DAILY_TICKET_LIMITS[2],
      soldCount: 0,
    },
    3: {
      dayNumber: 3,
      eventDate: FASTPASS_CONFIG.EVENT_DATES[3],
      ticketLimit: FASTPASS_CONFIG.DAILY_TICKET_LIMITS[3],
      soldCount: 0,
    },
  };
}

export function createWorkspace(
  kind: "LIVE" | "DEV",
  sequence: number,
  nowMs: number,
): Workspace {
  return {
    id: createId(kind.toLowerCase()),
    kind,
    status: "ACTIVE",
    sequence,
    startedAtMs: nowMs,
    endedAtMs: null,
    configRevision: "local-config-v1",
    configSnapshot: cloneConfig(),
    lastTicketNumber: 0,
    lastGroupNumber: 0,
    selectedTestDay: 1,
    businessDays: createBusinessDays(),
    expensesConfirmedAtMs: null,
  };
}

export function createInitialData(nowMs = Date.now()): FastpassData {
  const liveWorkspace = createWorkspace("LIVE", 1, nowMs);
  const deviceId = createId("device");
  return {
    schemaVersion: 1,
    savedAtMs: nowMs,
    system: {
      mode: "LIVE",
      modeEpoch: 1,
      maintenance: true,
      liveWorkspaceId: liveWorkspace.id,
      devWorkspaceId: null,
      device: {
        id: deviceId,
        name: "ローカル端末 1",
        createdAtMs: nowMs,
      },
    },
    workspaces: [liveWorkspace],
    checkouts: [],
    sales: [],
    tickets: [],
    ticketEvents: [],
    admissions: [],
    checkinReversals: [],
    refunds: [],
    cashboxes: [
      {
        id: "cashbox-main",
        workspaceId: liveWorkspace.id,
        name: "共通レジ",
      },
    ],
    cashLedger: [],
    expenses: [],
    cashCounts: [],
    operations: [],
    auditLogs: [
      {
        id: createId("audit"),
        workspaceId: liveWorkspace.id,
        type: "SYSTEM_INITIALIZED",
        status: "SUCCESS",
        occurredAtMs: nowMs,
        deviceId,
        operationId: null,
        detail: "localStorage確認版を初期化しました。営業停止状態です。",
      },
    ],
  };
}
