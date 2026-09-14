import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/infrastructure/apiClient";
import { createInitialData } from "../src/domain/initialState";

const id = "12345678-1234-4234-8234-123456789abc";
const snapshot = () => ({ data: createInitialData(), serverNowMs: 1000 });
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
const lookup = () => json({ found: true, operation: { requestId: id, type: "SELL_TICKETS", result: { saleId: "saved-sale" }, committedAtMs: 1000 } });
const mutation = () => json({ ...snapshot(), requestId: id, result: { saleId: "saved-sale" } });

beforeEach(() => localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe("操作結果の照合と重複防止", () => {
  it("コミット後の503を元の操作IDで照合し、POSTを再送しない", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: { code: "D1_DAILY_LIMIT_REACHED" } }, 503)).mockResolvedValueOnce(lookup()).mockResolvedValueOnce(json(snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    const response = await client.mutate("SELL_TICKETS", { quantity: 1 }, 1, id);
    expect(response.result).toEqual({ saleId: "saved-sale" });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/mutations", `/api/operations/${id}`, "/api/state"]);
    expect(client.pendingOperation()).toBeNull();
  });

  it("通信結果不明は再読込後も新規操作を止め、読み取りで復旧する", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json({ found: false, operation: null }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient().mutate("SELL_TICKETS", { quantity: 1 }, 1, id)).rejects.toMatchObject({ code: "OPERATION_OUTCOME_UNKNOWN" });
    const reloaded = new ApiClient();
    await expect(reloaded.mutate("SELL_TICKETS", { quantity: 1 }, 1)).rejects.toMatchObject({ code: "PENDING_OPERATION_BLOCKED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(json(snapshot()));
    await reloaded.recoverPendingOperation();
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(reloaded.pendingOperation()).toBeNull();
  });

  it("処理済みでも状態取得が失敗すれば保留を維持する", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(lookup()).mockResolvedValueOnce(json({}, 503));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await expect(client.mutate("SELL_TICKETS", { quantity: 1 }, 1, id)).rejects.toMatchObject({ code: "OPERATION_STATE_UNAVAILABLE" });
    expect(client.pendingOperation()).toMatchObject({ requestId: id, commitConfirmed: true });
    fetchMock.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(json(snapshot()));
    await client.recoverPendingOperation();
    expect(client.pendingOperation()).toBeNull();
  });

  it("不完全な200応答も成功扱いせず照合する", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({})).mockResolvedValueOnce(lookup()).mockResolvedValueOnce(json(snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient().mutate("SELL_TICKETS", { quantity: 1 }, 1, id)).resolves.toMatchObject({ result: { saleId: "saved-sale" } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("別タブの保留操作を上書きせず、自分の操作IDだけを照合する", async () => {
    const otherId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      localStorage.setItem(`bun3-fastpass:pending-operation:v1:${otherId}`, JSON.stringify({ requestId: otherId, action: "REFUND", modeEpoch: 1, startedAtMs: 1, commitConfirmed: false }));
      return json({}, 503);
    }).mockResolvedValueOnce(lookup()).mockResolvedValueOnce(json(snapshot()));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await expect(client.mutate("SELL_TICKETS", { quantity: 1 }, 1, id)).resolves.toMatchObject({ requestId: id, result: { saleId: "saved-sale" } });
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/operations/${id}`);
    expect(client.pendingOperation()).toMatchObject({ requestId: otherId, action: "REFUND" });
  });

  it("削除済みDEVの操作は再実行せず保留を解除する", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ found: true, operation: { requestId: id, type: "SELL_TICKETS", result: null, purged: true } })).mockResolvedValueOnce(json(snapshot())));
    const client = new ApiClient();
    await expect(client.mutate("SELL_TICKETS", { quantity: 1 }, 1, id)).rejects.toMatchObject({ code: "OPERATION_PURGED" });
    expect(client.pendingOperation()).toBeNull();
  });

  it("確実な競合拒否は保留を解除する", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ error: { code: "STATE_CONFLICT" } }, 409)));
    const client = new ApiClient();
    await expect(client.mutate("SELL_TICKETS", { quantity: 1 }, 1, id)).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(client.pendingOperation()).toBeNull();
  });

  it("破損した保留記録を勝手に消して操作を再開しない", async () => {
    localStorage.setItem("bun3-fastpass:pending-operation:v1", "broken");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(new ApiClient().mutate("SELL_TICKETS", { quantity: 1 }, 1, id)).rejects.toMatchObject({ code: "OPERATION_STORAGE_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem("bun3-fastpass:pending-operation:v1")).toBe("broken");
  });
});

describe("更新のない同期", () => {
  it("ETagを送り304ではデータを再利用しサーバー時刻は進める", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(snapshot(), 200, { ETag: '"v1"' })).mockResolvedValueOnce(new Response(null, { status: 304, headers: { "X-Server-Now-Ms": "31000" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient(); const first = await client.state(); const next = await client.state();
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("If-None-Match")).toBe('"v1"');
    expect(next.data).toBe(first.data); expect(next.serverNowMs).toBe(31000);
  });

  it("書込み前に始まった遅い状態取得がキャッシュを復元しない", async () => {
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })).mockResolvedValueOnce(mutation()).mockResolvedValueOnce(json(snapshot(), 200, { ETag: '"v2"' }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient(); const stale = client.state();
    await client.mutate("SELL_TICKETS", { quantity: 1 }, 1, id);
    finish(json(snapshot(), 200, { ETag: '"v1"' })); await stale; await client.state();
    expect(new Headers(fetchMock.mock.calls[2][1].headers).has("If-None-Match")).toBe(false);
  });
});
