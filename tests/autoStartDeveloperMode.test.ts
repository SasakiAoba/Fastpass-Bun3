import { describe, expect, it } from "vitest";
import { resolveAutoStartDeveloperMode } from "../src/config/autoStartDeveloperMode";

describe("自動DEV開始のビルド時解決", () => {
  it("ProductionはCloudflare環境変数がなくても無効にする", () => {
    expect(resolveAutoStartDeveloperMode({ mode: "production" })).toBe(false);
  });

  it("mainブランチのCloudflare Pages Productionは無効にする", () => {
    expect(resolveAutoStartDeveloperMode({
      mode: "production",
      cloudflarePages: "1",
      cloudflarePagesBranch: "main",
    })).toBe(false);
  });

  it("非mainブランチのCloudflare Pages Previewは有効にする", () => {
    expect(resolveAutoStartDeveloperMode({
      mode: "production",
      cloudflarePages: "1",
      cloudflarePagesBranch: "feature/startup-check",
    })).toBe(true);
  });

  it("ローカルではpreviewモードを明示した場合だけ有効にする", () => {
    expect(resolveAutoStartDeveloperMode({ mode: "development" })).toBe(false);
    expect(resolveAutoStartDeveloperMode({ mode: "preview" })).toBe(true);
  });
});
