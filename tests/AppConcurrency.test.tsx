import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { enableDeveloperMode, sellTickets } from "../src/domain/engine";
import { createInitialData } from "../src/domain/initialState";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function initialData() { const data = createInitialData(); enableDeveloperMode(data); return data; }
function setPollHook() {
  let poll!: () => void;
  const native = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation(((fn: TimerHandler, ms?: number) => {
    if (ms === 30000) poll = fn as () => void;
    return native(fn, ms);
  }) as typeof window.setInterval);
  return () => poll();
}
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("複数端末と遅い状態取得", () => {
  it.each([200, 401])("販売後に古い同期応答（%s）が届いても集計や認証を巻き戻さない", async (status) => {
    const old = initialData(); const next = structuredClone(old);
    const sale = sellTickets(next, 1, crypto.randomUUID());
    let readCount = 0; let finish!: (response: Response) => void;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/auth/status") return json({ authenticated: true, initialized: true, serverNowMs: Date.now() });
      if (path === "/api/state") {
        if (++readCount === 1) return json({ data: old, serverNowMs: Date.now() });
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      if (path === "/api/mutations") return json({ data: next, result: sale, requestId: JSON.parse(String(init?.body)).requestId, serverNowMs: Date.now() });
      throw new Error(path);
    });
    vi.stubGlobal("fetch", fetchMock); const poll = setPollHook(); render(<App />);
    await screen.findByRole("heading", { name: "受付を始めます" });
    await waitFor(() => expect(window.setInterval).toHaveBeenCalledWith(expect.any(Function), 30000));
    await act(async () => poll());
    fireEvent.click(screen.getByRole("button", { name: "販売", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "＋1" }));
    fireEvent.click(screen.getByRole("button", { name: "販売確定・1枚を発番" }));
    await screen.findByText("HC-001");
    await act(async () => finish(status === 200 ? json({ data: old, serverNowMs: Date.now() }) : json({ error: { code: "AUTH_REQUIRED", message: "expired" } }, 401)));
    fireEvent.click(screen.getByRole("button", { name: "ホーム", exact: true }));
    expect(screen.getByText("全体販売").closest("article")).toHaveTextContent("1枚");
  });

  it("別端末のモード変更で古い確認ダイアログを閉じる", async () => {
    const old = initialData(); const next = structuredClone(old); next.system.modeEpoch += 1; next.system.maintenance = true;
    let readCount = 0;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/auth/status") return json({ authenticated: true, initialized: true, serverNowMs: Date.now() });
      if (path === "/api/state") return json({ data: ++readCount === 1 ? old : next, serverNowMs: Date.now() });
      throw new Error(path);
    });
    vi.stubGlobal("fetch", fetchMock); const poll = setPollHook(); render(<App />);
    await screen.findByRole("heading", { name: "受付を始めます" });
    fireEvent.click(screen.getByRole("button", { name: "管理", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "営業を停止" }));
    expect(screen.getByRole("button", { name: "実行する" })).toBeVisible();
    await waitFor(() => expect(window.setInterval).toHaveBeenCalledWith(expect.any(Function), 30000));
    await act(async () => poll());
    await waitFor(() => expect(screen.queryByRole("button", { name: "実行する" })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/mutations")).toBe(false);
    expect(screen.getByRole("button", { name: "営業を再開" })).toBeVisible();
  });

  it("状態競合を受けた端末は直ちに最新状態を表示する", async () => {
    const old = initialData(); const next = structuredClone(old); next.system.modeEpoch += 1; next.system.maintenance = true;
    let readCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/auth/status") return json({ authenticated: true, initialized: true, serverNowMs: Date.now() });
      if (path === "/api/state") return json({ data: ++readCount === 1 ? old : next, serverNowMs: Date.now() });
      if (path === "/api/mutations") return json({ error: { code: "MODE_CHANGED", message: "営業状態が変わりました" } }, 409);
      throw new Error(path);
    }));
    render(<App />); await screen.findByRole("heading", { name: "受付を始めます" });
    fireEvent.click(screen.getByRole("button", { name: "販売", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "＋1" }));
    fireEvent.click(screen.getByRole("button", { name: "販売確定・1枚を発番" }));
    expect(await screen.findByRole("heading", { name: "営業停止中" })).toBeVisible();
    expect(readCount).toBe(2);
  });

  it("結果不明を持つ端末は再読込後も確定操作を止める", async () => {
    const data = initialData();
    localStorage.setItem("bun3-fastpass:pending-operation:v1", JSON.stringify({ requestId: crypto.randomUUID(), action: "SELL_TICKETS", modeEpoch: data.system.modeEpoch, startedAtMs: Date.now(), commitConfirmed: false }));
    const fetchMock = vi.fn(async (path: string) => {
      if (path === "/api/auth/status") return json({ authenticated: true, initialized: true, serverNowMs: Date.now() });
      if (path === "/api/state") return json({ data, serverNowMs: Date.now() });
      if (path.startsWith("/api/operations/")) return json({ found: false, operation: null });
      throw new Error(path);
    });
    vi.stubGlobal("fetch", fetchMock); render(<App />);
    await screen.findByRole("heading", { name: "前回の操作結果を確認してください" });
    fireEvent.click(screen.getByRole("button", { name: "販売", exact: true }));
    expect(screen.getByRole("button", { name: "＋1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "操作結果を読み取りで確認" }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0].startsWith("/api/operations/"))).toBe(true));
    expect(screen.getByRole("button", { name: "＋1" })).toBeDisabled();
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/mutations")).toBe(false);
  });
});
