import { describe, expect, it, vi } from "vitest";
import { enableDeveloperMode } from "../src/domain/engine";
import { createInitialData } from "../src/domain/initialState";
import { loadStartupState } from "../src/infrastructure/startup";
import type { StateResponse } from "../src/shared/api";

function response(data: ReturnType<typeof createInitialData>): StateResponse {
  return { data, serverNowMs: Date.now() };
}

describe("ログイン後の初期モード", () => {
  it("設定がtrueならLIVEから開発者モードを自動開始する", async () => {
    const live = createInitialData();
    const development = structuredClone(live);
    enableDeveloperMode(development);
    const client = {
      state: vi.fn().mockResolvedValue(response(live)),
      mutate: vi.fn().mockResolvedValue({ ...response(development), requestId: crypto.randomUUID(), result: {} }),
    };

    const startup = await loadStartupState(client, true);

    expect(client.mutate).toHaveBeenCalledWith("ENABLE_DEVELOPER_MODE", {}, live.system.modeEpoch);
    expect(startup.state.data.system.mode).toBe("DEVELOPMENT");
    expect(startup.autoStartError).toBeNull();
  });

  it("設定がfalseならLIVEを変更しない", async () => {
    const live = createInitialData();
    const client = {
      state: vi.fn().mockResolvedValue(response(live)),
      mutate: vi.fn(),
    };

    const startup = await loadStartupState(client, false);

    expect(client.mutate).not.toHaveBeenCalled();
    expect(startup.state.data.system.mode).toBe("LIVE");
  });

  it("すでに開発者モードなら新しいDEVを作成しない", async () => {
    const development = createInitialData();
    enableDeveloperMode(development);
    const client = {
      state: vi.fn().mockResolvedValue(response(development)),
      mutate: vi.fn(),
    };

    const startup = await loadStartupState(client, true);

    expect(client.mutate).not.toHaveBeenCalled();
    expect(startup.state.data.system.devWorkspaceId).toBe(development.system.devWorkspaceId);
  });

  it("同時切替の競合後に既存DEVを再取得する", async () => {
    const live = createInitialData();
    const development = structuredClone(live);
    enableDeveloperMode(development);
    const conflict = new Error("MODE_CHANGED");
    const client = {
      state: vi.fn()
        .mockResolvedValueOnce(response(live))
        .mockResolvedValueOnce(response(development)),
      mutate: vi.fn().mockRejectedValue(conflict),
    };

    const startup = await loadStartupState(client, true);

    expect(client.state).toHaveBeenCalledTimes(2);
    expect(startup.state.data.system.mode).toBe("DEVELOPMENT");
    expect(startup.autoStartError).toBeNull();
  });
});
