import { argon2idAsync } from "@noble/hashes/argon2.js";
import { ApiError, assertSameOrigin, constantTimeEqual, isUuid, json, randomToken, readJson, sha256Hex } from "./http";

export interface Env {
  DB: D1Database;
  AUTH_RATE_LIMIT_PEPPER?: string;
}

export type SessionContext = {
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
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;

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

function decodeBase64(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyArgon2id(password: string, encoded: string): Promise<boolean> {
  const fields = encoded.split("$");
  if (fields.length !== 6 || fields[0] !== "" || fields[1] !== "argon2id" || fields[2] !== "v=19") return false;
  const parameters = Object.fromEntries(fields[3].split(",").map((part) => part.split("=", 2)));
  const memory = Number(parameters.m);
  const iterations = Number(parameters.t);
  const parallelism = Number(parameters.p);
  if (!Number.isSafeInteger(memory) || memory < 19_456 || !Number.isSafeInteger(iterations) || iterations < 2 || !Number.isSafeInteger(parallelism) || parallelism < 1) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = decodeBase64(fields[4]);
    expected = decodeBase64(fields[5]);
  } catch {
    return false;
  }
  const actual = await argon2idAsync(new TextEncoder().encode(password), salt, {
    m: memory,
    t: iterations,
    p: parallelism,
    dkLen: expected.length,
    maxmem: 64 * 1024 * 1024,
    asyncTick: 10,
  });
  let difference = actual.length ^ expected.length;
  const length = Math.max(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) difference |= (actual[index] || 0) ^ (expected[index] || 0);
  return difference === 0;
}

async function scopeHash(request: Request, pepper: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const agent = request.headers.get("User-Agent") || "unknown";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ip}\n${agent}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
      WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL`,
  ).bind(tokenHash).first<{
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
  return json({ initialized: credential !== null, authenticated: session !== null, serverNowMs: Date.now() });
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
  if (!env.AUTH_RATE_LIMIT_PEPPER || env.AUTH_RATE_LIMIT_PEPPER.length < 32) {
    throw new ApiError(503, "SERVER_NOT_CONFIGURED", "認証用Secretが設定されていません。");
  }
  const credential = await env.DB.prepare(
    "SELECT password_hash, algorithm, memory_kib, iterations, parallelism, auth_generation FROM auth_credentials WHERE singleton_id = 1",
  ).first<{
    password_hash: string;
    algorithm: string;
    memory_kib: number;
    iterations: number;
    parallelism: number;
    auth_generation: number;
  }>();
  if (!credential) throw new ApiError(503, "AUTH_NOT_INITIALIZED", "初期パスワードがまだD1へ登録されていません。");
  if (credential.algorithm !== "argon2id") throw new ApiError(503, "AUTH_CONFIGURATION_INVALID", "認証方式を確認できません。");

  const nowMs = Date.now();
  const scope = await scopeHash(request, env.AUTH_RATE_LIMIT_PEPPER);
  const failures = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM login_attempts WHERE scope_key_hash = ? AND succeeded = 0 AND attempted_at_ms >= ? AND expires_at_ms > ?",
  ).bind(scope, nowMs - LOGIN_WINDOW_MS, nowMs).first<{ count: number }>();
  if ((failures?.count || 0) >= MAX_FAILED_LOGINS) {
    throw new ApiError(429, "LOGIN_RATE_LIMITED", "ログイン試行が多すぎます。15分後にやり直してください。");
  }

  const deviceName = body.deviceName.trim();
  await env.DB.prepare(
    `INSERT INTO devices (id, display_name, created_at_ms, last_seen_at_ms, disabled_at_ms)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, last_seen_at_ms = excluded.last_seen_at_ms
     WHERE devices.disabled_at_ms IS NULL`,
  ).bind(body.deviceId, deviceName, nowMs, nowMs).run();

  const succeeded = await verifyArgon2id(body.password, credential.password_hash);
  await env.DB.prepare(
    "INSERT INTO login_attempts (id, scope_key_hash, device_id, succeeded, attempted_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), scope, body.deviceId, succeeded ? 1 : 0, nowMs, nowMs + LOGIN_WINDOW_MS).run();
  if (!succeeded) throw new ApiError(401, "INVALID_CREDENTIALS", "パスワードが正しくありません。");

  const sessionToken = randomToken();
  const csrfToken = randomToken();
  const sessionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sessions (id, token_hash, csrf_token_hash, device_id, auth_generation, issued_at_ms, last_used_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    ).bind(sessionId, await sha256Hex(sessionToken), await sha256Hex(csrfToken), body.deviceId, credential.auth_generation, nowMs, nowMs),
    env.DB.prepare("DELETE FROM login_attempts WHERE expires_at_ms <= ?").bind(nowMs),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, workspace_id, device_id, session_id, operation_id, type, status, detail, occurred_at_ms) VALUES (?, NULL, ?, ?, NULL, 'LOGIN_SUCCEEDED', 'SUCCESS', '共有パスワードでログインしました。', ?)",
    ).bind(crypto.randomUUID(), body.deviceId, sessionId, nowMs),
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
      "INSERT INTO audit_logs (id, workspace_id, device_id, session_id, operation_id, type, status, detail, occurred_at_ms) VALUES (?, NULL, ?, ?, NULL, 'LOGOUT', 'SUCCESS', 'ログアウトしました。', ?)",
    ).bind(crypto.randomUUID(), session.deviceId, session.id, nowMs),
  ]);
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie("", 0));
  headers.append("Set-Cookie", csrfCookie("", 0));
  return json({ authenticated: false, initialized: true, serverNowMs: nowMs }, 200, headers);
}
