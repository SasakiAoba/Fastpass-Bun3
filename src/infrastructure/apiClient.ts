import type {
  ApiErrorBody,
  AuthStatusResponse,
  MutationAction,
  MutationPayload,
  MutationRequest,
  MutationResponse,
  StateResponse,
} from "../shared/api";

const DEVICE_ID_KEY = "bun3-fastpass:d1-device-id:v1";
const DEVICE_NAME_KEY = "bun3-fastpass:d1-device-name:v1";
const CSRF_COOKIE = "__Host-fastpass_csrf";

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

async function decode<T>(response: Response): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ApiClientError("INVALID_RESPONSE", "サーバーから正しい応答を受け取れませんでした。", undefined, response.status);
  }
  if (!response.ok) {
    const body = value as Partial<ApiErrorBody>;
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
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "サーバーへ接続できません。通信状態を確認してください。");
  }
  return decode<T>(response);
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
  status(): Promise<AuthStatusResponse> {
    return api<AuthStatusResponse>("/api/auth/status");
  }

  login(password: string): Promise<AuthStatusResponse> {
    const device = getDevice();
    return api<AuthStatusResponse>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, deviceId: device.id, deviceName: device.name }),
    });
  }

  async logout(): Promise<void> {
    await api("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": readCookie(CSRF_COOKIE) || "" },
      body: "{}",
    });
  }

  state(): Promise<StateResponse> {
    return api<StateResponse>("/api/state");
  }

  async mutate<T>(action: MutationAction, payload: MutationPayload, modeEpoch: number, requestId = crypto.randomUUID()): Promise<MutationResponse<T>> {
    const body: MutationRequest = { requestId, modeEpoch, action, payload };
    try {
      return await api<MutationResponse<T>>("/api/mutations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": readCookie(CSRF_COOKIE) || "" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.code !== "NETWORK_ERROR") throw error;
      try {
        const lookup = await api<{ found: boolean; operation: { result: T } | null }>(`/api/operations/${requestId}`);
        if (lookup.found && lookup.operation) {
          const state = await this.state();
          return { requestId, result: lookup.operation.result, ...state };
        }
      } catch {
        // 元の「結果不明」を維持する。新しいIDでの自動再実行はしない。
      }
      throw new ApiClientError("OPERATION_OUTCOME_UNKNOWN", "通信が途切れ、操作結果を確認できません。再度確定せず、記録画面と通信状態を確認してください。");
    }
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
