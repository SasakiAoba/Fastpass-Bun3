import { AUTO_START_DEVELOPER_MODE } from "../config/fastpass.config";
import type { StateResponse } from "../shared/api";
import { ApiClientError, EXPECTED_ENVIRONMENT, type ApiClient } from "./apiClient";

declare const __FASTPASS_AUTO_START_DEVELOPER_MODE__: boolean;

type StartupClient = Pick<ApiClient, "state" | "mutate">;

export type StartupState = {
  state: StateResponse;
  autoStartError: unknown | null;
};

export async function loadStartupState(
  client: StartupClient,
  autoStartDeveloperMode = typeof __FASTPASS_AUTO_START_DEVELOPER_MODE__ === "boolean"
    ? __FASTPASS_AUTO_START_DEVELOPER_MODE__
    : AUTO_START_DEVELOPER_MODE,
): Promise<StartupState> {
  const initial = await client.state();
  if (initial.data.system.environment !== EXPECTED_ENVIRONMENT) {
    throw new ApiClientError("ENVIRONMENT_MISMATCH", "画面とAPIの環境設定が一致しません。設定を確認してください。", undefined, 503);
  }
  if (!autoStartDeveloperMode || initial.data.system.mode !== "LIVE") {
    return { state: initial, autoStartError: null };
  }

  try {
    const state = await client.mutate(
      "ENABLE_DEVELOPER_MODE",
      {},
      initial.data.system.modeEpoch,
    );
    return { state, autoStartError: null };
  } catch (autoStartError) {
    const latest = await client.state();
    if (latest.data.system.mode === "DEVELOPMENT") {
      return { state: latest, autoStartError: null };
    }
    return { state: latest, autoStartError };
  }
}
