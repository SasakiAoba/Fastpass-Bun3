import { describe, expect, it } from "vitest";
import { errorResponse } from "../functions/lib/http";

describe("APIエラー応答", () => {
  it("D1の1日読み取り上限を利用者に判別できる応答へ変換する", async () => {
    const response = errorResponse(new Error("Your account has exceeded D1's free tier daily row read limit. [code: 7500]"));
    const body = await response.json() as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("D1_DAILY_LIMIT_REACHED");
    expect(body.error.message).toContain("日本時間9:00以降");
  });
});
