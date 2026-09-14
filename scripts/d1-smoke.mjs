import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const wrangler = `${root}node_modules/.bin/wrangler`;
const config = process.env.FASTPASS_WRANGLER_CONFIG || `${root}wrangler.jsonc`;
const temporaryPersistence = process.env.FASTPASS_D1_PERSIST ? null : mkdtempSync("/private/tmp/fastpass-d1-smoke-");
const persistence = process.env.FASTPASS_D1_PERSIST || temporaryPersistence;
const port = Number(process.env.FASTPASS_TEST_PORT || 8791);
const origin = `http://127.0.0.1:${port}`;
const password = "A1B2C3D";
const authSql = "INSERT INTO auth_credentials (singleton_id,password_hash,algorithm,memory_kib,iterations,parallelism,auth_generation,created_at_ms,updated_at_ms) VALUES (1,'unused-secret-managed','argon2id',19456,2,1,1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000) ON CONFLICT(singleton_id) DO NOTHING;";
const migrate = spawnSync(wrangler, ["d1", "migrations", "apply", "DB", "--config", config, "--local", "--persist-to", persistence], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: "/private/tmp/fastpass-wrangler-smoke-migrate.log" } });
if (migrate.status !== 0) throw new Error(`Local migrations failed: ${migrate.stderr || migrate.stdout}`);
const seed = spawnSync(wrangler, ["d1", "execute", "DB", "--config", config, "--local", "--persist-to", persistence, "--command", authSql, "-y"], { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: "/private/tmp/fastpass-wrangler-smoke-seed.log" } });
if (seed.status !== 0) throw new Error(`Local auth seed failed: ${seed.stderr || seed.stdout}`);

// One local runtime owns the SQLite file. The harness supplies the two distinct
// Pages environment bindings to the real API handler; no test route is deployed.
const bundled = await build({ stdin: { contents: `import { onRequest } from ${JSON.stringify(`${root}functions/api/[[path]].ts`)};
export default { fetch(request, env) {
  const url = new URL(request.url);
  const preview = url.pathname.startsWith('/__preview/');
  if (preview) url.pathname = url.pathname.slice('/__preview'.length);
  return onRequest({ request: new Request(url, request), env: { ...env, FASTPASS_ENVIRONMENT: preview ? 'preview' : 'production' }, params: { path: url.pathname.replace(/^\\/api\\//, '').split('/') } });
}};`, resolveDir: root, sourcefile: "local-environment-harness.ts", loader: "ts" }, bundle: true, format: "esm", platform: "browser", write: false });
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-09-10", port, host: "127.0.0.1", resourcePersistencePath: `${persistence}/v3`, d1Databases: { DB: "00000000-0000-0000-0000-000000000001" }, bindings: { AUTH_SHARED_PASSWORD: password } }));
await runtime.ready;
const previewOrigin = `${origin}/__preview`;
const serverOutput = "local Miniflare API harness";

let cookies = new Map();
function cookieHeader(jar = cookies) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
function rememberCookies(response, jar = cookies) {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") || ""];
  for (const value of values) {
    for (const match of value.matchAll(/(?:^|,\s*)(__Host-fastpass_(?:session|csrf))=([^;,]*)/gu)) jar.set(match[1], match[2]);
  }
}
async function call(path, { method = "GET", body, csrf = true, ok = true, jar = cookies, targetOrigin = origin } = {}) {
  const headers = { Origin: new URL(targetOrigin).origin, "Sec-Fetch-Site": "same-origin", "X-Fastpass-Environment": targetOrigin === previewOrigin ? "preview" : "production" };
  if (jar.size) headers.Cookie = cookieHeader(jar);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET") headers["X-CSRF-Token"] = decodeURIComponent(jar.get("__Host-fastpass_csrf") || "");
  const response = await fetch(`${targetOrigin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  rememberCookies(response, jar);
  const value = await response.json();
  if (ok && !response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(value)}`);
  if (!ok && response.ok) throw new Error(`${path} unexpectedly succeeded`);
  return { response, value };
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function request(action, payload, modeEpoch, requestId = crypto.randomUUID(), jar = cookies) {
  return call("/api/mutations", { method: "POST", body: { requestId, action, payload, modeEpoch }, jar });
}

try {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok && (await fetch(`${previewOrigin}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (attempt === 199) throw new Error(`Pages dev did not start: ${serverOutput}`);
  }
  const health = await call("/api/health");
  assert(health.value.schemaVersion === 5, "schema version is not 5");
  const wrong = await call("/api/auth/login", { method: "POST", csrf: false, ok: false, body: { password: "WRONG01", deviceId: crypto.randomUUID(), deviceName: "Wrong password" } });
  assert(wrong.response.status === 401 && wrong.value.error.code === "INVALID_CREDENTIALS", "wrong password was not rejected normally");
  await call("/api/auth/login", { method: "POST", csrf: false, body: { password, deviceId: crypto.randomUUID(), deviceName: "Local smoke" } });
  assert(cookies.has("__Host-fastpass_session") && cookies.has("__Host-fastpass_csrf"), "auth cookies were not set");
  const rejected = await call("/api/mutations", { method: "POST", csrf: false, ok: false, body: { requestId: crypto.randomUUID(), action: "ENABLE_DEVELOPER_MODE", payload: {}, modeEpoch: 1 } });
  assert(rejected.response.status === 403, "missing CSRF was not rejected");

  const staleClient = await fetch(`${origin}/api/mutations`, { method: "POST", headers: { Cookie: cookieHeader(), Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(cookies.get("__Host-fastpass_csrf") || "") }, body: JSON.stringify({ requestId: crypto.randomUUID(), action: "ENABLE_DEVELOPER_MODE", payload: {}, modeEpoch: 1 }) });
  assert(staleClient.status === 503, "old client without environment header was accepted");
  const copiedSession = await fetch(`${previewOrigin}/api/state`, { headers: { Cookie: cookieHeader() } });
  assert(copiedSession.status === 401, "Production session authenticated against Preview");
  const initialStateResponse = await call("/api/state");
  const initialEtag = initialStateResponse.response.headers.get("ETag");
  assert(initialEtag, "state response has no revision tag");
  const unchanged = await fetch(`${origin}/api/state`, { headers: { Cookie: cookieHeader(), "If-None-Match": initialEtag } });
  assert(unchanged.status === 304 && Number(unchanged.headers.get("X-Server-Now-Ms")) > 0, "unchanged poll did not skip full state with current server clock");
  const unauthenticatedConditional = await fetch(`${origin}/api/state`, { headers: { "If-None-Match": initialEtag } });
  assert(unauthenticatedConditional.status === 401, "conditional state bypassed authentication");
  // Both servers share the same local D1 file, but use independent operational scopes.
  const previewCookies = new Map();
  const previewCall = (path, options = {}) => call(path, { ...options, jar: previewCookies, targetOrigin: previewOrigin });
  const previewRequest = (action, payload, modeEpoch, requestId = crypto.randomUUID(), ok = true) => previewCall("/api/mutations", { method: "POST", body: { requestId, action, payload, modeEpoch }, ok });
  await previewCall("/api/auth/login", { method: "POST", csrf: false, body: { password, deviceId: crypto.randomUUID(), deviceName: "Preview isolated device" } });
  let previewState = (await previewCall("/api/state")).value;
  assert(previewState.data.system.environment === "preview" && initialStateResponse.value.data.system.environment === "production", "server environment was not authoritative");
  assert(previewState.data.system.liveWorkspaceId !== initialStateResponse.value.data.system.liveWorkspaceId, "Preview points at Production workspace");
  const disabledPreview = await previewRequest("SELL_TICKETS", { quantity: 1 }, previewState.data.system.modeEpoch, crypto.randomUUID(), false);
  assert(disabledPreview.value.error.code === "PREVIEW_DEVELOPMENT_REQUIRED", "Preview LIVE accepted business mutations");
  const mismatched = await fetch(`${previewOrigin}/api/state`, { headers: { Cookie: cookieHeader(previewCookies), "X-Fastpass-Environment": "production" } });
  assert(mismatched.status === 503, "frontend/backend environment mismatch was accepted");
  previewState = (await previewRequest("ENABLE_DEVELOPER_MODE", {}, previewState.data.system.modeEpoch)).value;
  const previewSaleId = crypto.randomUUID();
  const previewSale = (await previewRequest("SELL_TICKETS", { quantity: 1 }, previewState.data.system.modeEpoch, previewSaleId)).value;
  const productionAfterPreview = await fetch(`${origin}/api/state`, { headers: { Cookie: cookieHeader(), "If-None-Match": initialEtag } });
  assert(productionAfterPreview.status === 304, "Preview login/mode/sale invalidated Production state");
  assert((await call(`/api/operations/${previewSaleId}`)).value.found === false, "Preview receipt leaked into Production");
  await previewRequest("CONFIRM_HANDOVER", { kind: "SALE", sourceId: previewSale.result.saleId }, previewState.data.system.modeEpoch);
  let state = initialStateResponse.value;
  assert(state.data.system.mode === "LIVE", "initial mode is not LIVE");
  state = (await request("ENABLE_DEVELOPER_MODE", {}, state.data.system.modeEpoch)).value;
  assert(state.data.system.mode === "DEVELOPMENT", "DEV mode was not enabled");
  const changed = await fetch(`${origin}/api/state`, { headers: { Cookie: cookieHeader(), "If-None-Match": initialEtag } });
  assert(changed.status === 200 && changed.headers.get("ETag") !== initialEtag, "mode change did not invalidate conditional state");
  const epoch = state.data.system.modeEpoch;
  const previewAfterProduction = (await previewCall("/api/state")).value;
  assert(previewAfterProduction.data.tickets.length === 1 && previewAfterProduction.data.system.devWorkspaceId !== state.data.system.devWorkspaceId, "Production DEV interfered with Preview DEV");
  previewState = (await previewRequest("DISABLE_DEVELOPER_MODE", {}, previewState.data.system.modeEpoch)).value;
  assert(previewState.data.system.maintenance && previewState.data.tickets.length === 0, "Preview purge did not stop and empty Preview");
  const productionAfterPurge = (await call("/api/state")).value;
  assert(productionAfterPurge.data.system.modeEpoch === epoch && productionAfterPurge.data.system.mode === "DEVELOPMENT", "Preview purge changed Production mode");
  assert((await previewCall(`/api/operations/${previewSaleId}`)).value.operation?.purged === true, "Preview purged receipt unavailable");
  assert((await call(`/api/operations/${previewSaleId}`)).value.found === false, "Preview purged receipt leaked into Production");
  const previewExport = await previewCall("/api/exports/json", { ok: false });
  assert(previewExport.value.error.code === "PREVIEW_EXPORT_DISABLED", "Preview exposed Production exports");
  const sale1 = (await request("SELL_TICKETS", { quantity: 6 }, epoch)).value.result;
  assert(sale1.ticketNumbers.length === 6 && sale1.totalYen === 600 && sale1.tenderedYen === 600 && sale1.changeYen === 0, "sale totals or tickets are incorrect");
  await request("CONFIRM_HANDOVER", { kind: "SALE", sourceId: sale1.saleId }, epoch);
  const checkin = await request("CHECKIN", { serialNumbers: sale1.ticketNumbers.slice(0, 5) }, epoch);
  const afterCheckin = checkin.value.data;
  const first = afterCheckin.tickets.find((ticket) => ticket.serialNumber === sale1.ticketNumbers[0]);
  assert(first?.status === "USED" && first.currentUseEventId, "check-in did not persist");
  await request("REVERSE_CHECKIN", { serialNumber: first.serialNumber, expectedUseEventId: first.currentUseEventId, reason: "smoke" }, epoch);
  const refund = (await request("REFUND", { serialNumbers: [first.serialNumber, sale1.ticketNumbers[5]], reason: "smoke" }, epoch)).value.result;
  assert(refund.totalYen === 200, "refund total is incorrect");
  await request("CONFIRM_HANDOVER", { kind: "REFUND", sourceId: refund.id }, epoch);

  const sale2RequestId = crypto.randomUUID();
  const sale2Response = await request("SELL_TICKETS", { quantity: 2 }, epoch, sale2RequestId);
  const sale2 = sale2Response.value.result;
  const replay = await request("SELL_TICKETS", { quantity: 2 }, epoch, sale2RequestId);
  assert(replay.value.result.saleId === sale2.saleId, "idempotent replay changed result");
  const immediate = await request("HANDOVER_AND_CHECKIN", { saleId: sale2.saleId }, epoch);
  assert(immediate.value.data.tickets.filter((ticket) => sale2.ticketNumbers.includes(ticket.serialNumber)).every((ticket) => ticket.status === "USED"), "immediate use did not mark all tickets used");

  const secondDeviceCookies = new Map();
  await call("/api/auth/login", { method: "POST", csrf: false, jar: secondDeviceCookies, body: { password, deviceId: crypto.randomUUID(), deviceName: "Second independent device" } });
  assert(secondDeviceCookies.get("__Host-fastpass_session") !== cookies.get("__Host-fastpass_session"), "devices did not receive independent sessions");
  const [saleA, saleB] = await Promise.all([
    request("SELL_TICKETS", { quantity: 1 }, epoch),
    request("SELL_TICKETS", { quantity: 1 }, epoch, crypto.randomUUID(), secondDeviceCookies),
  ]);
  assert(saleA.value.result.ticketNumbers[0] !== saleB.value.result.ticketNumbers[0], "concurrent sales allocated the same ticket number");
  await Promise.all([
    request("CONFIRM_HANDOVER", { kind: "SALE", sourceId: saleA.value.result.saleId }, epoch),
    request("CONFIRM_HANDOVER", { kind: "SALE", sourceId: saleB.value.result.saleId }, epoch, crypto.randomUUID(), secondDeviceCookies),
  ]);
  const competingNumber = saleA.value.result.ticketNumbers[0];
  const competing = await Promise.allSettled([
    request("CHECKIN", { serialNumbers: [competingNumber] }, epoch),
    request("CHECKIN", { serialNumbers: [competingNumber] }, epoch, crypto.randomUUID(), secondDeviceCookies),
  ]);
  assert(competing.filter((result) => result.status === "fulfilled").length === 1, "competing check-ins did not produce exactly one success");
  assert(competing.filter((result) => result.status === "rejected").length === 1, "competing check-ins did not reject exactly one request");

  const secondView = (await call("/api/state", { jar: secondDeviceCookies })).value;
  assert(secondView.data.tickets.find((ticket) => ticket.serialNumber === competingNumber)?.status === "USED", "second device did not read the committed check-in");
  await call("/api/auth/logout", { method: "POST", body: {}, jar: secondDeviceCookies });
  assert((await call("/api/auth/status")).value.authenticated === true, "logging out a second device revoked the first session");

  state = (await request("SET_DEVELOPER_DAY", { dayNumber: 2 }, epoch)).value;
  assert(state.data.system.modeEpoch === epoch + 1, "day change did not advance epoch");
  state = (await request("DISABLE_DEVELOPER_MODE", {}, state.data.system.modeEpoch)).value;
  assert(state.data.system.mode === "LIVE" && state.data.system.maintenance === true && state.data.system.devWorkspaceId === null, "DEV purge did not return to stopped LIVE");
  assert(state.data.sales.length === 0 && state.data.tickets.length === 0, "DEV records remained visible after purge");

  const purgedReceipt = (await call(`/api/operations/${sale2RequestId}`)).value;
  assert(purgedReceipt.found && purgedReceipt.operation.purged && purgedReceipt.operation.result === null, "purged DEV request lost its safe recovery receipt");
  const purgedReplay = await call("/api/mutations", { method: "POST", ok: false, body: { requestId: sale2RequestId, action: "SELL_TICKETS", payload: { quantity: 2 }, modeEpoch: state.data.system.modeEpoch } });
  assert(purgedReplay.value.error.code === "OPERATION_PURGED", "purged request ID could be reused");

  const originalLiveId = state.data.system.liveWorkspaceId;
  state = (await request("RESET_LIVE_WORKSPACE", {}, state.data.system.modeEpoch)).value;
  const freshWorkspace = state.data.workspaces.find((workspace) => workspace.id === state.data.system.liveWorkspaceId);
  assert(state.data.system.liveWorkspaceId !== originalLiveId, "empty LIVE reset did not create a new workspace");
  assert(freshWorkspace.businessDays[1].eventDate === "2026-09-18" && freshWorkspace.businessDays[3].eventDate === "2026-09-20", "LIVE reset lost event dates");

  // Local-only fixture: today's LIVE sale verifies server reset/end-date gates.
  const todayJst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const localDb = await runtime.getD1Database("DB");
  await localDb.prepare(`UPDATE business_days SET event_date = CASE day_number WHEN 1 THEN ? WHEN 2 THEN '2099-09-19' ELSE '2099-09-20' END WHERE workspace_id = (SELECT current_live_workspace_id FROM system_state WHERE singleton_id = 1)`).bind(todayJst).run();

  state = (await request("SET_MAINTENANCE", { maintenance: false }, state.data.system.modeEpoch)).value;
  const liveSale = (await request("SELL_TICKETS", { quantity: 1 }, state.data.system.modeEpoch)).value.result;
  state = (await request("SET_MAINTENANCE", { maintenance: true }, state.data.system.modeEpoch)).value;
  const pendingReset = await call("/api/mutations", { method: "POST", ok: false, body: { requestId: crypto.randomUUID(), action: "RESET_LIVE_WORKSPACE", payload: {}, modeEpoch: state.data.system.modeEpoch } });
  assert(pendingReset.value.error.code === "PENDING_HANDOVER_EXISTS", "pending handover did not block LIVE reset");
  await request("CONFIRM_HANDOVER", { kind: "SALE", sourceId: liveSale.saleId }, state.data.system.modeEpoch);
  const activeEventReset = await call("/api/mutations", { method: "POST", ok: false, body: { requestId: crypto.randomUUID(), action: "RESET_LIVE_WORKSPACE", payload: {}, modeEpoch: state.data.system.modeEpoch } });
  assert(activeEventReset.value.error.code === "RESET_NOT_ALLOWED", "LIVE reset accepted sales before final event date");
  const afterResetRejection = (await call("/api/state")).value;
  assert(afterResetRejection.data.system.liveWorkspaceId === state.data.system.liveWorkspaceId && afterResetRejection.data.tickets.length === 1, "rejected reset modified LIVE data");

  await call("/api/auth/logout", { method: "POST", body: {} });
  const status = await call("/api/auth/status");
  assert(status.value.authenticated === false, "logout did not revoke the session");
  cookies = new Map();
  await call("/api/auth/login", { method: "POST", csrf: false, body: { password, deviceId: crypto.randomUUID(), deviceName: "Re-login" } });
  assert(cookies.has("__Host-fastpass_session"), "re-login after logout failed");
  await call("/api/auth/logout", { method: "POST", body: {} });
  process.stdout.write("D1 smoke: PASS (wrong-then-correct auth, CSRF, direct DEV sale, check-in, reversal, refund, immediate use, idempotency, independent-device concurrency, shared-D1 environment isolation, conditional polling, purge, LIVE reset/date guards, logout/re-login)\n");
} finally {
  await runtime.dispose();
  if (temporaryPersistence) rmSync(temporaryPersistence, { recursive: true, force: true });
}
