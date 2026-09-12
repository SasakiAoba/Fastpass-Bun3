import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { enableDeveloperMode, setMaintenance } from "../src/domain/engine";
import { createInitialData } from "../src/domain/initialState";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("営業停止中の操作画面", () => {
  it("販売と入場の操作を隠し、管理画面から再開すると復帰する", async () => {
    let data = createInitialData();
    enableDeveloperMode(data);
    setMaintenance(data, true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const serverNowMs = Date.now();

      if (path === "/api/auth/status") {
        return jsonResponse({ authenticated: true, initialized: true, serverNowMs });
      }
      if (path === "/api/state") {
        return jsonResponse({ data, serverNowMs });
      }
      if (path === "/api/mutations") {
        const request = JSON.parse(String(init?.body)) as { requestId: string; action: string };
        expect(request.action).toBe("SET_MAINTENANCE");
        data = structuredClone(data);
        data.system.maintenance = false;
        data.system.modeEpoch += 1;
        data.savedAtMs = serverNowMs;
        return jsonResponse({ requestId: request.requestId, result: null, data, serverNowMs });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<App />);
    await screen.findByRole("heading", { name: "受付を始めます" });

    expect(screen.queryByText("D1同期運用")).not.toBeInTheDocument();
    expect(screen.queryByText("販売・入場・払い戻し・会計を端末間で共有")).not.toBeInTheDocument();
    expect(screen.queryByText("本番・運用回1")).not.toBeInTheDocument();
    expect(screen.queryByText("ローカル端末 1")).not.toBeInTheDocument();
    expect(screen.queryByText("日本時間")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "販売", exact: true }));
    expect(screen.getByRole("heading", { name: "営業停止中" })).toBeVisible();
    expect(screen.queryByText("人数を入力")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "人数をカートへ追加" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "入場受付", exact: true }));
    expect(screen.getByRole("heading", { name: "営業停止中" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "入場受付" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "番号を一覧へ追加" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "管理", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "営業を再開" }));
    fireEvent.click(screen.getByRole("button", { name: "実行する" }));
    await waitFor(() => expect(data.system.maintenance).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "販売", exact: true }));
    expect(await screen.findByRole("heading", { name: "人数を入力" })).toBeVisible();
    expect(screen.getByRole("button", { name: "人数をカートへ追加" })).toBeDisabled();

    unmount();
  });
});
