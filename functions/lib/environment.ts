import { ApiError } from "./http";

export type RuntimeScope = { id: 1 | 2; key: "production" | "preview" };

export function runtimeScope(env: { FASTPASS_ENVIRONMENT?: string }): RuntimeScope {
  if (env.FASTPASS_ENVIRONMENT === "production") return { id: 1, key: "production" };
  if (env.FASTPASS_ENVIRONMENT === "preview") return { id: 2, key: "preview" };
  throw new ApiError(503, "ENVIRONMENT_NOT_CONFIGURED", "実行環境の設定を確認できません。");
}
