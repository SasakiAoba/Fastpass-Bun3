import { AUTO_START_DEVELOPER_MODE } from "../config/fastpass.config";
import type { StateResponse } from "../shared/api";
import type { ApiClient } from "./apiClient";

type StartupClient = Pick<ApiClient, "state" | "mutate">;

export type StartupState = {
  state: StateResponse;
  autoStartError: unknown | null;
};

export async function loadStartupState(
  client: StartupClient,
  autoStartDeveloperMode = AUTO_START_DEVELOPER_MODE,
): Promise<StartupState> {
  const initial = await client.state();
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
