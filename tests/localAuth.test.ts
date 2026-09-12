import { beforeEach, describe, expect, it } from "vitest";
import {
  beginLocalSession,
  endLocalSession,
  isLocalSessionValid,
} from "../src/infrastructure/localAuth";

describe("ローカルログイン状態", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("ログイン状態をlocalStorageへ保持し、タブ用ストレージに依存しない", () => {
    beginLocalSession(Date.parse("2026-09-12T09:00:00+09:00"));
    sessionStorage.clear();
    expect(isLocalSessionValid()).toBe(true);
  });

  it("明示的なログアウトでログイン状態を終了する", () => {
    beginLocalSession();
    endLocalSession();
    expect(isLocalSessionValid()).toBe(false);
  });
});
