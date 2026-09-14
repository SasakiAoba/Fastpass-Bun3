import type {
  ApiErrorBody,
  AuthStatusResponse,
  MutationAction,
  MutationPayload,
  MutationRequest,
  MutationResponse,
  StateResponse,
} from "../shared/api";

declare const __FASTPASS_AUTO_START_DEVELOPER_MODE__: boolean;
export const EXPECTED_ENVIRONMENT = typeof __FASTPASS_AUTO_START_DEVELOPER_MODE__ === "boolean" && __FASTPASS_AUTO_START_DEVELOPER_MODE__ ? "preview" : "production";

const DEVICE_ID_KEY = "bun3-fastpass:d1-device-id:v1";
const DEVICE_NAME_KEY = "bun3-fastpass:d1-device-name:v1";
const PENDING_OPERATION_KEY = "bun3-fastpass:pending-operation:v1";
const CSRF_COOKIE = "__Host-fastpass_csrf";

const MUTATION_ACTIONS: readonly MutationAction[] = [
  "SELL_TICKETS",
  "CREATE_CHECKOUT",
  "CANCEL_CHECKOUT",
  "FINALIZE_SALE",
  "CONFIRM_HANDOVER",
  "HANDOVER_AND_CHECKIN",
  "CHECKIN",
  "REVERSE_CHECKIN",
  "REFUND",
  "SET_MAINTENANCE",
  "ENABLE_DEVELOPER_MODE",
  "SET_DEVELOPER_DAY",
  "DISABLE_DEVELOPER_MODE",
  "RESET_LIVE_WORKSPACE",
  "RENAME_DEVICE",
];

export type PendingOperation = {
  requestId: string;
  action: MutationAction;
  modeEpoch: number;
  startedAtMs: number;
  commitConfirmed: boolean;
};

type OperationLookup<T> = {
  found: boolean;
  operation: {
    requestId: string;
    type: MutationAction;
    result: T;
    committedAtMs: number;
    purged?: boolean;
  } | null;
};

export class ApiClientError extends Error {
  constructor(readonly code: string, message: string, readonly details?: string[], readonly status = 0) {
    super(message);
  }
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const index = part.indexOf("=");
    if (index < 1 || part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

async function decode<T>(response: Response, path: string): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    const contentType = response.headers.get("Content-Type")?.split(";", 1)[0] || "不明";
    const ray = response.headers.get("CF-Ray");
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "サーバーからJSON形式の応答を受け取れませんでした。再試行しても続く場合は管理者へ連絡してください。",
      [`接続先: ${path}`, `HTTP状態: ${response.status || "不明"}`, `応答形式: ${contentType}`, ...(ray ? [`CF-Ray: ${ray}`] : [])],
      response.status,
    );
  }
  if (!response.ok) {
    const body = (value && typeof value === "object" ? value : {}) as Partial<ApiErrorBody>;
    throw new ApiClientError(
      body.error?.code || `HTTP_${response.status}`,
      body.error?.message || "操作を完了できませんでした。",
      body.error?.details,
      response.status,
    );
  }
  return value as T;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return decode<T>(response, path);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    headers.set("X-Fastpass-Environment", EXPECTED_ENVIRONMENT);
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init, headers });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "サーバーへ接続できません。通信状態を確認してください。");
  }
  return response;
}

function isMutationAction(value: unknown): value is MutationAction {
  return typeof value === "string" && MUTATION_ACTIONS.includes(value as MutationAction);
}

function readPendingOperation(requestId?: string): PendingOperation | null {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => !!key && (key === PENDING_OPERATION_KEY || key.startsWith(`${PENDING_OPERATION_KEY}:`)));
    const pending: PendingOperation[] = [];
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let value: Partial<PendingOperation>;
      try { value = JSON.parse(raw); } catch { throw new Error("invalid pending operation"); }
      if (!value || typeof value.requestId !== "string" || !/^[0-9a-f-]{36}$/iu.test(value.requestId) ||
        !isMutationAction(value.action) || !Number.isSafeInteger(value.modeEpoch) || (value.modeEpoch || 0) < 1 ||
        !Number.isSafeInteger(value.startedAtMs) || (value.startedAtMs || 0) <= 0 || typeof value.commitConfirmed !== "boolean") {
        throw new Error("invalid pending operation");
      }
      if (!requestId || value.requestId === requestId) pending.push(value as PendingOperation);
    }
    return pending.sort((a, b) => a.startedAtMs - b.startedAtMs || a.requestId.localeCompare(b.requestId))[0] || null;
  } catch {
    throw new ApiClientError("OPERATION_STORAGE_INVALID", "前回の操作記録を読み取れません。重複処理を防ぐため操作を停止しています。管理者がサーバーの記録を確認してください。");
  }
}

function writePendingOperation(operation: PendingOperation): void {
  try {
    localStorage.setItem(`${PENDING_OPERATION_KEY}:${operation.requestId}`, JSON.stringify(operation));
  } catch {
    throw new ApiClientError(
      "OPERATION_STORAGE_UNAVAILABLE",
      "操作IDを端末内に保存できないため、安全に操作を開始できません。ブラウザの保存設定を確認してください。",
    );
  }
}

function clearPendingOperation(requestId: string): void {
  try {
    localStorage.removeItem(`${PENDING_OPERATION_KEY}:${requestId}`);
    const legacy = localStorage.getItem(PENDING_OPERATION_KEY);
    if (legacy && JSON.parse(legacy).requestId === requestId) localStorage.removeItem(PENDING_OPERATION_KEY);
  } catch {
    throw new ApiClientError("OPERATION_STORAGE_UNAVAILABLE", "操作は確認できましたが、端末内の保留記録を解除できません。ブラウザの保存設定を確認してください。");
  }
}

function canHaveCommitted(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return true;
  return error.code === "NETWORK_ERROR" || error.status >= 500 || (
    error.code === "INVALID_RESPONSE" && error.status >= 200 && error.status < 300
  );
}

function outcomeUnknown(operation: PendingOperation, cause?: unknown): ApiClientError {
  const causeCode = cause instanceof ApiClientError ? cause.code : null;
  return new ApiClientError(
    "OPERATION_OUTCOME_UNKNOWN",
    "通信またはサーバー応答が途中で止まり、操作結果を確認できません。元の操作を再実行せず、「操作結果を読み取りで確認」を押してください。",
    [
      `操作ID: ${operation.requestId}`,
      `操作種別: ${operation.action}`,
      ...(causeCode ? [`確認時の状態: ${causeCode}`] : []),
    ],
  );
}

export function getDevice(): { id: string; name: string } {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  const name = localStorage.getItem(DEVICE_NAME_KEY)?.trim() || "ファストパス端末";
  return { id, name };
}

export function rememberDeviceName(name: string): void {
  localStorage.setItem(DEVICE_NAME_KEY, name.trim());
}

export class ApiClient {
  private stateCache: { etag: string; state: StateResponse } | null = null;
  private stateCacheGeneration = 0;

  private invalidateStateCache(): void {
    this.stateCacheGeneration += 1;
    this.stateCache = null;
  }

  pendingOperation(): PendingOperation | null {
    return readPendingOperation();
  }

  status(): Promise<AuthStatusResponse> {
    return api<AuthStatusResponse>("/api/auth/status");
  }

  async login(password: string): Promise<AuthStatusResponse> {
    const device = getDevice();
    const status = await api<AuthStatusResponse>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, deviceId: device.id, deviceName: device.name }),
    });
    this.invalidateStateCache();
    return status;
  }

  async logout(): Promise<void> {
    await api("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": readCookie(CSRF_COOKIE) || "" },
      body: "{}",
    });
    this.invalidateStateCache();
  }

  async state(): Promise<StateResponse> {
    const generation = this.stateCacheGeneration;
    const cached = this.stateCache;
    const response = await request("/api/state", {
      headers: cached ? { "If-None-Match": cached.etag } : undefined,
    });
    if (response.status === 304) {
      if (!cached) {
        throw new ApiClientError(
          "INVALID_RESPONSE",
          "サーバーが未更新を返しましたが、端末に比較元のデータがありません。もう一度読み込んでください。",
          ["接続先: /api/state", "HTTP状態: 304"],
          304,
        );
      }
      const serverNowMs = Number(response.headers.get("X-Server-Now-Ms"));
      if (!Number.isSafeInteger(serverNowMs) || serverNowMs <= 0) {
        throw new ApiClientError(
          "INVALID_RESPONSE",
          "サーバー時刻を確認できませんでした。もう一度読み込んでください。",
          ["接続先: /api/state", "HTTP状態: 304"],
          304,
        );
      }
      return { data: cached.state.data, serverNowMs };
    }
    const state = await decode<StateResponse>(response, "/api/state");
    if (state.data?.system?.environment !== EXPECTED_ENVIRONMENT) throw new ApiClientError("ENVIRONMENT_MISMATCH", "画面とAPIの環境設定が一致しません。", undefined, 503);
    const etag = response.headers.get("ETag");
    if (etag && generation === this.stateCacheGeneration) this.stateCache = { etag, state };
    return state;
  }

  async mutate<T>(action: MutationAction, payload: MutationPayload, modeEpoch: number, requestId = crypto.randomUUID()): Promise<MutationResponse<T>> {
    const existing = readPendingOperation();
    if (existing) {
      throw new ApiClientError(
        "PENDING_OPERATION_BLOCKED",
        "前回の操作結果が未確認のため、新しい操作を開始できません。「操作結果を読み取りで確認」を押してください。",
        [`操作ID: ${existing.requestId}`, `操作種別: ${existing.action}`],
        409,
      );
    }
    const pending: PendingOperation = {
      requestId,
      action,
      modeEpoch,
      startedAtMs: Date.now(),
      commitConfirmed: false,
    };
    writePendingOperation(pending);
    const body: MutationRequest = { requestId, modeEpoch, action, payload };
    let response: MutationResponse<T>;
    try {
      response = await api<MutationResponse<T>>("/api/mutations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": readCookie(CSRF_COOKIE) || "" },
        body: JSON.stringify(body),
      });
      if (!response || response.requestId !== requestId || response.data?.system?.environment !== EXPECTED_ENVIRONMENT || !Number.isFinite(response.serverNowMs) || !("result" in response)) {
        throw new ApiClientError("INVALID_RESPONSE", "操作結果の形式を確認できませんでした。", undefined, 200);
      }
    } catch (error) {
      if (!canHaveCommitted(error)) {
        clearPendingOperation(requestId);
        throw error;
      }
      try {
        return await this.recoverPendingOperation<T>(requestId);
      } catch (recoveryError) {
        if (recoveryError instanceof ApiClientError && (
          recoveryError.status === 401 || ["OPERATION_STATE_UNAVAILABLE", "OPERATION_PURGED"].includes(recoveryError.code)
        )) throw recoveryError;
        throw outcomeUnknown(pending, recoveryError);
      }
    }
    this.invalidateStateCache();
    clearPendingOperation(requestId);
    return response;
  }

  async recoverPendingOperation<T = unknown>(expectedRequestId?: string): Promise<MutationResponse<T>> {
    const pending = readPendingOperation(expectedRequestId);
    if (!pending) {
      throw new ApiClientError("NO_PENDING_OPERATION", "確認待ちの操作はありません。", undefined, 409);
    }
    const lookup = await api<OperationLookup<T>>(`/api/operations/${pending.requestId}`);
    if (
      !lookup.found ||
      !lookup.operation ||
      lookup.operation.requestId !== pending.requestId ||
      lookup.operation.type !== pending.action
    ) {
      throw outcomeUnknown(pending);
    }
    if (!pending.commitConfirmed) writePendingOperation({ ...pending, commitConfirmed: true });
    this.invalidateStateCache();
    let state: StateResponse;
    try {
      state = await this.state();
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) throw error;
      const code = error instanceof ApiClientError ? error.code : "UNKNOWN_ERROR";
      throw new ApiClientError(
        "OPERATION_STATE_UNAVAILABLE",
        "前回の操作はサーバーに記録済みですが、最新データを読み込めません。新しい操作は停止したままです。もう一度、読み取りで確認してください。",
        [`操作ID: ${pending.requestId}`, `状態取得: ${code}`],
        error instanceof ApiClientError ? error.status : 0,
      );
    }
    clearPendingOperation(pending.requestId);
    if (lookup.operation.purged) throw new ApiClientError("OPERATION_PURGED", "前回の操作はテストデータの終了時に削除済みです。再実行せず、現在のモードを確認してください。", undefined, 409);
    return { requestId: pending.requestId, result: lookup.operation.result, ...state };
  }
}

export function downloadD1Export(kind: "json" | "tickets" | "sales" | "refunds" | "audit"): void {
  const link = document.createElement("a");
  link.href = `/api/exports/${kind}`;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}
