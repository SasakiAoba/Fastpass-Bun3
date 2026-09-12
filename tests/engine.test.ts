import { describe, expect, it } from "vitest";
import {
  checkInTickets,
  confirmHandover,
  createCheckout,
  disableDeveloperMode,
  enableDeveloperMode,
  finalizeSale,
  getActiveWorkspace,
  getSummary,
  refundTickets,
  reverseCheckin,
} from "../src/domain/engine";
import { FastpassError } from "../src/domain/errors";
import { createInitialData } from "../src/domain/initialState";

function createDevelopmentData(nowMs = Date.parse("2026-09-10T09:00:00+09:00")) {
  const data = createInitialData(nowMs);
  enableDeveloperMode(data, nowMs);
  return data;
}

function sell(
  data: ReturnType<typeof createInitialData>,
  quantity: number,
  tenderedYen: number,
  id: string,
  nowMs = Date.parse("2026-09-10T09:01:00+09:00"),
) {
  const checkout = createCheckout(data, quantity, `${id}-hold`, nowMs);
  return finalizeSale(data, checkout.id, tenderedYen, `${id}-sale`, nowMs + 1_000);
}

describe("販売と発番", () => {
  it("開催日未設定のLIVE販売を拒否する", () => {
    const data = createInitialData();
    data.system.maintenance = false;
    expect(() => createCheckout(data, 1, "hold-live")).toThrowError(FastpassError);
    try {
      createCheckout(data, 1, "hold-live-2");
    } catch (error) {
      expect(error).toMatchObject({ code: "EVENT_DATE_NOT_CONFIGURED" });
    }
  });

  it("DEVでは001から連続発番し、会計・釣銭・グループを記録する", () => {
    const data = createDevelopmentData();
    const result = sell(data, 3, 1_000, "first");
    expect(result.ticketNumbers).toEqual([1, 2, 3]);
    expect(result.groupNumber).toBe(1);
    expect(result.totalYen).toBe(300);
    expect(result.changeYen).toBe(700);
    expect(data.tickets).toHaveLength(3);
    expect(data.cashLedger).toHaveLength(1);
    expect(data.cashLedger[0].amountYen).toBe(300);
  });

  it("同じ販売操作IDの再送は同じ結果を返し、二重発番しない", () => {
    const data = createDevelopmentData();
    const checkout = createCheckout(data, 2, "hold-once");
    const first = finalizeSale(data, checkout.id, 500, "sale-once");
    const second = finalizeSale(data, checkout.id, 500, "sale-once");
    expect(second).toEqual(first);
    expect(data.sales).toHaveLength(1);
    expect(data.tickets).toHaveLength(2);
  });

  it("同じ操作IDを異なる内容に使うと競合する", () => {
    const data = createDevelopmentData();
    createCheckout(data, 1, "same-id");
    expect(() => createCheckout(data, 2, "same-id")).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    );
  });

  it("DEVでは200と999を超えて番号を切り捨てず発番する", () => {
    const data = createDevelopmentData();
    const workspace = getActiveWorkspace(data);
    workspace.lastTicketNumber = 998;
    const result = sell(data, 3, 500, "wide-number");
    expect(result.ticketNumbers).toEqual([999, 1000, 1001]);
  });
});

describe("入場・取消・払い戻し", () => {
  it("一括入場の対象に使用済み券があると全件を変更しない", () => {
    const data = createDevelopmentData();
    sell(data, 2, 500, "entry");
    checkInTickets(data, [1], "checkin-first");
    expect(() => checkInTickets(data, [1, 2], "checkin-conflict")).toThrowError(
      expect.objectContaining({ code: "TICKET_STATE_CONFLICT" }),
    );
    expect(data.tickets.find((ticket) => ticket.serialNumber === 2)?.status).toBe("ISSUED");
  });

  it("古い使用イベントIDで再使用後の券を取り消せない", () => {
    const data = createDevelopmentData();
    sell(data, 1, 100, "reverse");
    checkInTickets(data, [1], "checkin-a");
    const firstUseId = data.tickets[0].currentUseEventId!;
    reverseCheckin(data, 1, "誤入力", firstUseId, "reverse-a");
    checkInTickets(data, [1], "checkin-b");
    expect(() => reverseCheckin(data, 1, "古い画面", firstUseId, "reverse-old")).toThrowError(
      expect.objectContaining({ code: "TICKET_STATE_CONFLICT" }),
    );
    expect(data.tickets[0].status).toBe("USED");
  });

  it("払い戻し後も販売枚数と最終番号を戻さない", () => {
    const data = createDevelopmentData();
    const sale = sell(data, 2, 500, "refund");
    confirmHandover(data, "SALE", sale.saleId, "handover-sale");
    const beforeWorkspace = getActiveWorkspace(data);
    const lastNumber = beforeWorkspace.lastTicketNumber;
    const soldCount = beforeWorkspace.businessDays[1].soldCount;
    const refund = refundTickets(data, [1], "利用取りやめ", "refund-one");
    expect(refund.totalYen).toBe(100);
    expect(getActiveWorkspace(data).lastTicketNumber).toBe(lastNumber);
    expect(getActiveWorkspace(data).businessDays[1].soldCount).toBe(soldCount);
    const next = sell(data, 1, 100, "after-refund");
    expect(next.ticketNumbers).toEqual([3]);
  });
});

describe("LIVEとDEVの分離", () => {
  it("DEV終了時にDEVデータだけを削除し、LIVE領域を保持する", () => {
    const data = createInitialData();
    const liveId = data.system.liveWorkspaceId;
    enableDeveloperMode(data);
    const devId = data.system.devWorkspaceId!;
    const result = sell(data, 1, 100, "dev-only");
    confirmHandover(data, "SALE", result.saleId, "dev-handover");
    disableDeveloperMode(data);
    expect(data.system.mode).toBe("LIVE");
    expect(data.system.maintenance).toBe(true);
    expect(data.system.liveWorkspaceId).toBe(liveId);
    expect(data.system.devWorkspaceId).toBeNull();
    expect(data.workspaces.some((workspace) => workspace.id === devId)).toBe(false);
    expect(data.tickets.some((ticket) => ticket.workspaceId === devId)).toBe(false);
    expect(data.workspaces.some((workspace) => workspace.id === liveId)).toBe(true);
  });

  it("DEV集計は上限なしとして表示する", () => {
    const data = createDevelopmentData();
    sell(data, 4, 500, "summary");
    const summary = getSummary(data);
    expect(summary.dailyLimit).toBeNull();
    expect(summary.availableToday).toBeNull();
    expect(summary.totalSold).toBe(4);
    expect(summary.checkoutCount).toBe(1);
    expect(summary.totalTenderedYen).toBe(500);
    expect(summary.totalChangeYen).toBe(100);
    expect(summary.finalProfitYen).toBe(400);
    expect(summary.netSalesYen).toBe(400);
  });

  it("預り金、お釣り、最終利益、払戻後残額を販売記録から集計する", () => {
    const data = createDevelopmentData();
    const first = sell(data, 2, 500, "accounting-first");
    confirmHandover(data, "SALE", first.saleId, "accounting-first-handover");
    sell(data, 1, 200, "accounting-second");
    refundTickets(data, [1], "利用取りやめ", "accounting-refund");

    const summary = getSummary(data);
    expect(summary.totalSold).toBe(3);
    expect(summary.checkoutCount).toBe(2);
    expect(summary.totalTenderedYen).toBe(700);
    expect(summary.totalChangeYen).toBe(400);
    expect(summary.finalProfitYen).toBe(300);
    expect(summary.refundsYen).toBe(100);
    expect(summary.netSalesYen).toBe(200);
  });
});
