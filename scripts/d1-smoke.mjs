import { spawn, spawnSync } from "node:child_process";
import { argon2idAsync } from "@noble/hashes/argon2.js";

const root = new URL("..", import.meta.url).pathname;
const wrangler = `${root}node_modules/.bin/wrangler`;
const config = process.env.FASTPASS_WRANGLER_CONFIG || `${root}wrangler.jsonc`;
const persistence = process.env.FASTPASS_D1_PERSIST || "/private/tmp/fastpass-d1-local2";
const port = Number(process.env.FASTPASS_TEST_PORT || 8791);
const origin = `http://127.0.0.1:${port}`;
const password = "Local-D1-Test-Only-9";
const pepper = "local-test-pepper-not-used-in-any-deployment-2026";

function base64url(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const salt = new TextEncoder().encode("local-test-salt!");
const derived = await argon2idAsync(new TextEncoder().encode(password), salt, { m: 19_456, t: 2, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024, asyncTick: 10 });
const hash = `$argon2id$v=19$m=19456,t=2,p=1$${base64url(salt)}$${base64url(derived)}`;
const authSql = `INSERT INTO auth_credentials (singleton_id,password_hash,algorithm,memory_kib,iterations,parallelism,auth_generation,created_at_ms,updated_at_ms) VALUES (1,'${hash}','argon2id',19456,2,1,1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000) ON CONFLICT(singleton_id) DO UPDATE SET password_hash=excluded.password_hash,updated_at_ms=excluded.updated_at_ms;`;
const seed = spawnSync(wrangler, ["d1", "execute", "DB", "--config", config, "--local", "--persist-to", persistence, "--command", authSql, "-y"], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: "/private/tmp/fastpass-wrangler-smoke-seed.log" } });
if (seed.status !== 0) throw new Error(`Local auth seed failed: ${seed.stderr || seed.stdout}`);

const server = spawn(wrangler, ["pages", "dev", "dist", "--binding", `AUTH_RATE_LIMIT_PEPPER=${pepper}`, "--persist-to", persistence, "--ip", "127.0.0.1", "--port", String(port), "--log-level", "error"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_LOG_PATH: "/private/tmp/fastpass-wrangler-smoke-server.log" },
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

let cookies = new Map();
function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
function rememberCookies(response) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  for (const value of values) {
    for (const match of value.matchAll(/(?:^|,\s*)(__Host-fastpass_(?:session|csrf))=([^;,]*)/gu)) cookies.set(match[1], match[2]);
  }
}
async function call(path, { method = "GET", body, csrf = true, ok = true } = {}) {
  const headers = { Origin: origin, "Sec-Fetch-Site": "same-origin" };
  if (cookies.size) headers.Cookie = cookieHeader();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET") headers["X-CSRF-Token"] = decodeURIComponent(cookies.get("__Host-fastpass_csrf") || "");
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  rememberCookies(response);
  const value = await response.json();
  if (ok && !response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(value)}`);
  if (!ok && response.ok) throw new Error(`${path} unexpectedly succeeded`);
  return { response, value };
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function request(action, payload, modeEpoch, requestId = crypto.randomUUID()) {
  return call("/api/mutations", { method: "POST", body: { requestId, action, payload, modeEpoch } });
}

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (attempt === 79) throw new Error(`Pages dev did not start: ${serverOutput}`);
  }
  const health = await call("/api/health");
  assert(health.value.schemaVersion === 2, "schema version is not 2");
  await call("/api/auth/login", { method: "POST", csrf: false, body: { password, deviceId: crypto.randomUUID(), deviceName: "Local smoke" } });
  assert(cookies.has("__Host-fastpass_session") && cookies.has("__Host-fastpass_csrf"), "auth cookies were not set");
  const rejected = await call("/api/mutations", { method: "POST", csrf: false, ok: false, body: { requestId: crypto.randomUUID(), action: "ENABLE_DEVELOPER_MODE", payload: {}, modeEpoch: 1 } });
  assert(rejected.response.status === 403, "missing CSRF was not rejected");

  let state = (await call("/api/state")).value;
  assert(state.data.system.mode === "LIVE", "initial mode is not LIVE");
  state = (await request("ENABLE_DEVELOPER_MODE", {}, state.data.system.modeEpoch)).value;
  assert(state.data.system.mode === "DEVELOPMENT", "DEV mode was not enabled");
  const epoch = state.data.system.modeEpoch;
  const hold1 = (await request("CREATE_CHECKOUT", { quantity: 6 }, epoch)).value.result;
  const sale1 = (await request("FINALIZE_SALE", { checkoutId: hold1.id, tenderedYen: 1000 }, epoch)).value.result;
  assert(sale1.ticketNumbers.length === 6 && sale1.changeYen === 400, "sale totals or tickets are incorrect");
  await request("CONFIRM_HANDOVER", { kind: "SALE", sourceId: sale1.saleId }, epoch);
  const checkin = await request("CHECKIN", { serialNumbers: sale1.ticketNumbers.slice(0, 5) }, epoch);
  const afterCheckin = checkin.value.data;
  const first = afterCheckin.tickets.find((ticket) => ticket.serialNumber === sale1.ticketNumbers[0]);
  assert(first?.status === "USED" && first.currentUseEventId, "check-in did not persist");
  await request("REVERSE_CHECKIN", { serialNumber: first.serialNumber, expectedUseEventId: first.currentUseEventId, reason: "smoke" }, epoch);
  const refund = (await request("REFUND", { serialNumbers: [first.serialNumber, sale1.ticketNumbers[5]], reason: "smoke" }, epoch)).value.result;
  assert(refund.totalYen === 200, "refund total is incorrect");
  await request("CONFIRM_HANDOVER", { kind: "REFUND", sourceId: refund.id }, epoch);

  const hold2 = (await request("CREATE_CHECKOUT", { quantity: 2 }, epoch)).value.result;
  const sale2RequestId = crypto.randomUUID();
  const sale2Response = await request("FINALIZE_SALE", { checkoutId: hold2.id, tenderedYen: 200 }, epoch, sale2RequestId);
  const sale2 = sale2Response.value.result;
  const replay = await request("FINALIZE_SALE", { checkoutId: hold2.id, tenderedYen: 200 }, epoch, sale2RequestId);
  assert(replay.value.result.saleId === sale2.saleId, "idempotent replay changed result");
  const immediate = await request("HANDOVER_AND_CHECKIN", { saleId: sale2.saleId }, epoch);
  assert(immediate.value.data.tickets.filter((ticket) => sale2.ticketNumbers.includes(ticket.serialNumber)).every((ticket) => ticket.status === "USED"), "immediate use did not mark all tickets used");

  const [holdA, holdB] = await Promise.all([
    request("CREATE_CHECKOUT", { quantity: 1 }, epoch),
    request("CREATE_CHECKOUT", { quantity: 1 }, epoch),
  ]);
  const [saleA, saleB] = await Promise.all([
    request("FINALIZE_SALE", { checkoutId: holdA.value.result.id, tenderedYen: 100 }, epoch),
    request("FINALIZE_SALE", { checkoutId: holdB.value.result.id, tenderedYen: 100 }, epoch),
  ]);
  assert(saleA.value.result.ticketNumbers[0] !== saleB.value.result.ticketNumbers[0], "concurrent sales allocated the same ticket number");
  await Promise.all([
    request("CONFIRM_HANDOVER", { kind: "SALE", sourceId: saleA.value.result.saleId }, epoch),
    request("CONFIRM_HANDOVER", { kind: "SALE", sourceId: saleB.value.result.saleId }, epoch),
  ]);
  const competingNumber = saleA.value.result.ticketNumbers[0];
  const competing = await Promise.allSettled([
    request("CHECKIN", { serialNumbers: [competingNumber] }, epoch),
    request("CHECKIN", { serialNumbers: [competingNumber] }, epoch),
  ]);
  assert(competing.filter((result) => result.status === "fulfilled").length === 1, "competing check-ins did not produce exactly one success");
  assert(competing.filter((result) => result.status === "rejected").length === 1, "competing check-ins did not reject exactly one request");

  state = (await request("SET_DEVELOPER_DAY", { dayNumber: 2 }, epoch)).value;
  assert(state.data.system.modeEpoch === epoch + 1, "day change did not advance epoch");
  state = (await request("DISABLE_DEVELOPER_MODE", {}, state.data.system.modeEpoch)).value;
  assert(state.data.system.mode === "LIVE" && state.data.system.maintenance === true && state.data.system.devWorkspaceId === null, "DEV purge did not return to stopped LIVE");
  assert(state.data.sales.length === 0 && state.data.tickets.length === 0, "DEV records remained visible after purge");

  await call("/api/auth/logout", { method: "POST", body: {} });
  const status = await call("/api/auth/status");
  assert(status.value.authenticated === false, "logout did not revoke the session");
  process.stdout.write("D1 smoke: PASS (auth, CSRF, DEV sale, check-in, reversal, refund, immediate use, idempotency, concurrency, purge, logout)\n");
} finally {
  server.kill("SIGTERM");
}
