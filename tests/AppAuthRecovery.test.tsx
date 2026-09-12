import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ログイン後の通信障害", () => {
  it("認証成功後の状態取得失敗をパスワード失敗にせず、再読込画面を出す", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (path === "/api/auth/status") return jsonResponse({ authenticated: false, initialized: true, serverNowMs: Date.now() });
      if (path === "/api/auth/login") return jsonResponse({ authenticated: true, initialized: true, serverNowMs: Date.now() });
      if (path === "/api/state") return new Response("upstream failure", { status: 502, headers: { "Content-Type": "text/html", "CF-Ray": "test-ray" } });
      if (path === "/api/auth/logout") return new Response("worker failure", { status: 500, headers: { "Content-Type": "text/html" } });
      throw new Error(`unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("heading", { name: "管理画面を開く" });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "A1B2C3D" } });
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));

    expect(await screen.findByRole("heading", { name: "運用データを読み込めません" })).toBeVisible();
    expect(screen.getByText("ログイン済み")).toBeVisible();
    expect(screen.queryByLabelText("パスワード")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "運用データを読み込めません" })).toBeVisible());
    expect(screen.queryByLabelText("パスワード")).not.toBeInTheDocument();
  });
});
