import type { ApiErrorBody } from "../../src/shared/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const body: ApiErrorBody = {
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "サーバー処理を完了できませんでした。",
      ...(known && error.details ? { details: error.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };
  if (!known) console.error("Unhandled API error", error);
  return json(body, status);
}

export async function readJson<T>(request: Request, maximumBytes = 32_768): Promise<T> {
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "JSON形式で送信してください。");
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maximumBytes) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "送信データが大きすぎます。");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "送信データが大きすぎます。");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "JSONを読み取れませんでした。");
  }
}

export function assertSameOrigin(request: Request): void {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (!origin || origin !== url.origin) {
    throw new ApiError(403, "ORIGIN_REJECTED", "このページ以外からの操作は受け付けません。");
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new ApiError(403, "ORIGIN_REJECTED", "このページ以外からの操作は受け付けません。");
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError(400, "INVALID_INPUT", `${name}は${minimum}～${maximum}の整数で入力してください。`);
  }
  return value as number;
}

export function requireText(value: unknown, name: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_INPUT", `${name}を入力してください。`);
  const trimmed = value.trim();
  if (trimmed.length < minimum || trimmed.length > maximum) {
    throw new ApiError(400, "INVALID_INPUT", `${name}は${minimum}～${maximum}文字で入力してください。`);
  }
  return trimmed;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let different = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return different === 0;
}

export function getJstDateString(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowMs);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}
