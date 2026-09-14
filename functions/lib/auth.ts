import { ApiError, assertSameOrigin, constantTimeEqual, isUuid, json, randomToken, readJson, sha256Hex } from "./http";

import { runtimeScope, type RuntimeScope } from "./environment";

export interface Env {
  FASTPASS_ENVIRONMENT?: string;
  DB: D1Database;
  AUTH_SHARED_PASSWORD?: string;
}

export type SessionContext = {
  scope: RuntimeScope;
  id: string;
  deviceId: string;
  deviceName: string;
  csrfTokenHash: string;
  authGeneration: number;
};

type LoginBody = {
  password?: unknown;
  deviceId?: unknown;
  deviceName?: unknown;
};

const SESSION_COOKIE = "__Host-fastpass_session";
const CSRF_COOKIE = "__Host-fastpass_csrf";
const SESSION_MAX_AGE_SECONDS = 34_560_000;
const PASSWORD_PATTERN = /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{7}$/u;

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

function sessionCookie(value: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

function csrfCookie(value: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${CSRF_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`;
}

async function verifySharedPassword(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const [candidateKey, expectedKey] = await Promise.all([
    crypto.subtle.importKey("raw", encoder.encode(candidate), algorithm, false, ["sign"]),
    crypto.subtle.importKey("raw", encoder.encode(expected), algorithm, false, ["verify"]),
  ]);
  const signature = await crypto.subtle.sign("HMAC", candidateKey, encoder.encode("fastpass-shared-password-v1"));
  return crypto.subtle.verify("HMAC", expectedKey, signature, encoder.encode("fastpass-shared-password-v1"));
}

export async function readSession(request: Request, env: Env): Promise<SessionContext | null> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id, s.device_id, s.csrf_token_hash, s.auth_generation, d.display_name
       FROM sessions AS s
       JOIN devices AS d ON d.id = s.device_id AND d.disabled_at_ms IS NULL
       JOIN auth_credentials AS a ON a.singleton_id = 1 AND a.auth_generation = s.auth_generation
      WHERE s.token_hash = ? AND s.environment = ? AND s.revoked_at_ms IS NULL`,
  ).bind(tokenHash, runtimeScope(env).key).first<{
    id: string;
    device_id: string;
    csrf_token_hash: string;
    auth_generation: number;
    display_name: string;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.display_name,
    csrfTokenHash: row.csrf_token_hash,
    authGeneration: row.auth_generation,
    scope: runtimeScope(env),
  };
}

export async function requireSession(request: Request, env: Env, csrf = false): Promise<SessionContext> {
  const session = await readSession(request, env);
  if (!session) throw new ApiError(401, "AUTH_REQUIRED", "ログインしてください。");
  if (csrf) {
    assertSameOrigin(request);
    const cookies = parseCookies(request);
    const cookieToken = cookies.get(CSRF_COOKIE) || "";
    const headerToken = request.headers.get("X-CSRF-Token") || "";
    if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
      throw new ApiError(403, "CSRF_REJECTED", "操作確認情報が一致しません。画面を再読み込みしてください。");
    }
    const hash = await sha256Hex(headerToken);
    if (!constantTimeEqual(hash, session.csrfTokenHash)) {
      throw new ApiError(403, "CSRF_REJECTED", "操作確認情報が一致しません。画面を再読み込みしてください。");
    }
  }
  return session;
}

export async function authStatus(request: Request, env: Env): Promise<Response> {
  const [credential, session] = await Promise.all([
    env.DB.prepare("SELECT 1 AS present FROM auth_credentials WHERE singleton_id = 1").first(),
    readSession(request, env),
  ]);
  const secretConfigured = typeof env.AUTH_SHARED_PASSWORD === "string" && PASSWORD_PATTERN.test(env.AUTH_SHARED_PASSWORD);
  return json({ initialized: credential !== null && secretConfigured, authenticated: session !== null && secretConfigured, serverNowMs: Date.now() });
}

export async function login(request: Request, env: Env): Promise<Response> {
  assertSameOrigin(request);
  const body = await readJson<LoginBody>(request, 4096);
  if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 256) {
    throw new ApiError(400, "INVALID_INPUT", "パスワードを入力してください。");
  }
  if (!isUuid(body.deviceId) || typeof body.deviceName !== "string" || body.deviceName.trim().length < 1 || body.deviceName.trim().length > 100) {
    throw new ApiError(400, "INVALID_DEVICE", "端末情報を確認できません。");
  }
  if (!env.AUTH_SHARED_PASSWORD || !PASSWORD_PATTERN.test(env.AUTH_SHARED_PASSWORD)) {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "共有パスワードSecretが正しく設定されていません。");
  }
  const credential = await env.DB.prepare(
    "SELECT auth_generation FROM auth_credentials WHERE singleton_id = 1",
  ).first<{
    auth_generation: number;
  }>();
  if (!credential) throw new ApiError(503, "AUTH_NOT_INITIALIZED", "D1の認証世代情報が未登録です。");

  const nowMs = Date.now();
  const deviceName = body.deviceName.trim();
  if (!(await verifySharedPassword(body.password, env.AUTH_SHARED_PASSWORD))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "パスワードが正しくありません。");
  }

  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const sessionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices (id, display_name, created_at_ms, last_seen_at_ms, disabled_at_ms)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, last_seen_at_ms = excluded.last_seen_at_ms
       WHERE devices.disabled_at_ms IS NULL`,
    ).bind(body.deviceId, deviceName, nowMs, nowMs),
    env.DB.prepare(
      "INSERT INTO sessions (id, token_hash, csrf_token_hash, device_id, auth_generation, issued_at_ms, last_used_at_ms, revoked_at_ms, environment) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    ).bind(sessionId, await sha256Hex(sessionToken), await sha256Hex(csrfToken), body.deviceId, credential.auth_generation, nowMs, nowMs, runtimeScope(env).key),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, workspace_id, device_id, session_id, operation_id, type, status, detail, occurred_at_ms, environment) VALUES (?, NULL, ?, ?, NULL, 'LOGIN_SUCCEEDED', 'SUCCESS', '共有パスワードでログインしました。', ?, ?)",
    ).bind(crypto.randomUUID(), body.deviceId, sessionId, nowMs, runtimeScope(env).key),
  ]);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(sessionToken));
  headers.append("Set-Cookie", csrfCookie(csrfToken));
  return json({ authenticated: true, initialized: true, serverNowMs: nowMs }, 200, headers);
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env, true);
  const nowMs = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET revoked_at_ms = COALESCE(revoked_at_ms, ?), last_used_at_ms = ? WHERE id = ?").bind(nowMs, nowMs, session.id),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, workspace_id, device_id, session_id, operation_id, type, status, detail, occurred_at_ms, environment) VALUES (?, NULL, ?, ?, NULL, 'LOGOUT', 'SUCCESS', 'ログアウトしました。', ?, ?)",
    ).bind(crypto.randomUUID(), session.deviceId, session.id, nowMs, runtimeScope(env).key),
  ]);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie("", 0));
  headers.append("Set-Cookie", csrfCookie("", 0));
  return json({ authenticated: false, initialized: true, serverNowMs: nowMs }, 200, headers);
}
