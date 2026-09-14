import type { MutationRequest } from "../../src/shared/api";
import { authStatus, login, logout, requireSession, type Env } from "../lib/auth";
import { ApiError, errorResponse, isUuid, json, readJson } from "../lib/http";
import { runtimeScope } from "../lib/environment";
import { mutate } from "../lib/mutations";
import { loadState, loadStateEtag } from "../lib/state";

function pathParts(context: EventContext<Env, string, Record<string, unknown>>): string[] {
  const raw = context.params.path;
  return Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("/").filter(Boolean) : [];
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(headers: string[], records: unknown[][]): string {
  return `\uFEFF${[headers, ...records].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

async function exportResponse(request: Request, env: Env, kind: string): Promise<Response> {
  const session = await requireSession(request, env);
  if (session.scope.key === "preview") throw new ApiError(409, "PREVIEW_EXPORT_DISABLED", "本番データの出力はProductionから行ってください。");
  const { data } = await loadState(env.DB, session);
  const workspaceId = data.system.mode === "DEVELOPMENT" ? data.system.devWorkspaceId : data.system.liveWorkspaceId;
  if (!workspaceId) throw new ApiError(500, "INVALID_SYSTEM_STATE", "出力対象を確認できません。");
  const workspace = data.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new ApiError(500, "INVALID_SYSTEM_STATE", "出力対象を確認できません。");
  if (workspace.kind === "DEV") throw new ApiError(409, "DEV_EXPORT_DISABLED", "開発者モード中は正式な業務出力を利用できません。");
  let body: string;
  let extension: string;
  let contentType: string;
  if (kind === "json") {
    body = JSON.stringify({
      exportVersion: 2,
      exportedAtMs: Date.now(),
      workspace,
      sales: data.sales,
      tickets: data.tickets,
      ticketEvents: data.ticketEvents,
      admissions: data.admissions,
      checkinReversals: data.checkinReversals,
      refunds: data.refunds,
      auditLogs: data.auditLogs.filter((entry) => entry.workspaceId === workspaceId),
    }, null, 2);
    extension = "json";
    contentType = "application/json; charset=utf-8";
  } else if (kind === "tickets") {
    const sales = new Map(data.sales.map((sale) => [sale.id, sale]));
    body = csv(["番号", "グループ", "状態", "購入日時ms", "販売日", "使用日時ms", "払戻日時ms", "更新番号"], data.tickets.map((ticket) => {
      const sale = sales.get(ticket.saleId);
      return [`HC-${String(ticket.serialNumber).padStart(3, "0")}`, sale ? `G-${String(sale.groupNumber).padStart(4, "0")}` : "", ticket.status, sale?.purchasedAtMs, sale?.dayNumber, ticket.usedAtMs, ticket.refundedAtMs, ticket.version];
    }));
    extension = "csv";
    contentType = "text/csv; charset=utf-8";
  } else if (kind === "sales") {
    body = csv(["販売ID", "グループ", "販売日", "枚数", "単価", "販売金額", "購入日時ms", "番号", "受渡確認日時ms"], data.sales.map((sale) => [
      sale.id, `G-${String(sale.groupNumber).padStart(4, "0")}`, sale.dayNumber, sale.quantity, sale.unitPriceYen,
      sale.totalYen, sale.purchasedAtMs,
      sale.ticketNumbers.map((number) => `HC-${String(number).padStart(3, "0")}`).join(" "), sale.handoverConfirmedAtMs,
    ]));
    extension = "csv";
    contentType = "text/csv; charset=utf-8";
  } else if (kind === "refunds") {
    const tickets = new Map(data.tickets.map((ticket) => [ticket.id, ticket]));
    body = csv(["払戻ID", "番号", "金額", "理由", "処理日時ms", "受渡確認日時ms"], data.refunds.map((refund) => [
      refund.id, refund.ticketIds.map((id) => tickets.get(id)).filter(Boolean).map((ticket) => `HC-${String(ticket!.serialNumber).padStart(3, "0")}`).join(" "),
      refund.totalYen, refund.reason, refund.occurredAtMs, refund.handoverConfirmedAtMs,
    ]));
    extension = "csv";
    contentType = "text/csv; charset=utf-8";
  } else if (kind === "audit") {
    body = csv(["履歴ID", "種類", "状態", "処理日時ms", "端末", "操作ID", "内容"], data.auditLogs.filter((entry) => entry.workspaceId === workspaceId).map((entry) => [
      entry.id, entry.type, entry.status, entry.occurredAtMs, entry.deviceId, entry.operationId, entry.detail,
    ]));
    extension = "csv";
    contentType = "text/csv; charset=utf-8";
  } else {
    throw new ApiError(404, "NOT_FOUND", "出力種別が見つかりません。");
  }
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, { headers: {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="fastpass-live-${workspace.sequence}-${date}-${kind}.${extension}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  } });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const request = context.request;
  const method = request.method.toUpperCase();
  const parts = pathParts(context);
  let requestId: string | undefined;
  try {
    if (!context.env.DB) throw new ApiError(503, "DB_BINDING_MISSING", "D1 Binding「DB」が設定されていません。");
    const scope = runtimeScope(context.env);
    const expectedEnvironment = request.headers.get("X-Fastpass-Environment");
    if ((expectedEnvironment && expectedEnvironment !== scope.key) || (method === "POST" && parts[0] === "mutations" && expectedEnvironment !== scope.key)) throw new ApiError(503, "ENVIRONMENT_MISMATCH", "画面とAPIの環境設定が一致しません。");
    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      const migration = await context.env.DB.prepare("SELECT MAX(version) AS version FROM schema_migrations").first<{ version: number | null }>();
      return json({ ok: true, environment: scope.key, schemaVersion: migration?.version || 0, serverNowMs: Date.now() });
    }
    if (method === "GET" && parts.join("/") === "auth/status") return await authStatus(request, context.env);
    if (method === "POST" && parts.join("/") === "auth/login") return await login(request, context.env);
    if (method === "POST" && parts.join("/") === "auth/logout") return await logout(request, context.env);
    if (method === "GET" && parts.length === 1 && parts[0] === "state") {
      const session = await requireSession(request, context.env);
      const etag = await loadStateEtag(context.env.DB, session);
      if (request.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers: {
          "ETag": etag, "Cache-Control": "no-store", "X-Server-Now-Ms": String(Date.now()),
        } });
      }
      return json(await loadState(context.env.DB, session), 200, { "ETag": etag });
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "mutations") {
      const session = await requireSession(request, context.env, true);
      const body = await readJson<MutationRequest>(request);
      requestId = typeof body.requestId === "string" ? body.requestId : undefined;
      const result = await mutate(context.env.DB, session, body);
      const state = await loadState(context.env.DB, session);
      return json({ requestId: body.requestId, result, ...state });
    }
    if (method === "GET" && parts.length === 2 && parts[0] === "operations") {
      await requireSession(request, context.env);
      if (!isUuid(parts[1])) throw new ApiError(400, "INVALID_REQUEST_ID", "操作IDを確認できません。");
      const found = await context.env.DB.prepare("SELECT o.request_id, o.type, o.result_json, o.committed_at_ms FROM business_operations o JOIN workspaces w ON w.id = o.workspace_id WHERE o.request_id = ? AND w.environment = ? ORDER BY o.committed_at_ms DESC LIMIT 1").bind(parts[1], scope.key).first<{ request_id: string; type: string; result_json: string; committed_at_ms: number }>();
      if (!found) {
        const purged = await context.env.DB.prepare("SELECT request_id, type, committed_at_ms FROM purged_operation_receipts WHERE request_id = ? AND environment = ?").bind(parts[1], scope.key).first<{ request_id: string; type: string; committed_at_ms: number }>();
        if (purged) return json({ found: true, operation: { requestId: purged.request_id, type: purged.type, result: null, committedAtMs: purged.committed_at_ms, purged: true } });
      }
      return json({ found: found !== null, operation: found ? { requestId: found.request_id, type: found.type, result: JSON.parse(found.result_json), committedAtMs: found.committed_at_ms } : null });
    }
    if (method === "GET" && parts.length === 2 && parts[0] === "exports") return await exportResponse(request, context.env, parts[1]);
    throw new ApiError(404, "NOT_FOUND", "APIが見つかりません。");
  } catch (error) {
    return errorResponse(error, requestId);
  }
};
