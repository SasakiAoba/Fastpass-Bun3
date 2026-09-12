import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountingScreen } from "../src/client/screens/AccountingScreen";
import { AdminScreen } from "../src/client/screens/AdminScreen";
import { AdmissionScreen } from "../src/client/screens/AdmissionScreen";
import { HomeScreen } from "../src/client/screens/HomeScreen";
import { SalesScreen } from "../src/client/screens/SalesScreen";
import type { Mutate, RequestConfirmation } from "../src/client/uiTypes";
import {
  confirmHandover,
  checkInTickets,
  enableDeveloperMode,
  getActiveWorkspace,
  getSummary,
  refundTickets,
  sellTickets,
} from "../src/domain/engine";
import { createInitialData } from "../src/domain/initialState";

function createDevelopmentData() {
  const data = createInitialData();
  enableDeveloperMode(data);
  return data;
}

function sell(
  data: ReturnType<typeof createInitialData>,
  quantity: number,
  _tenderedYen: number,
  id: string,
) {
  return sellTickets(data, quantity, id);
}

function directMutate(data: ReturnType<typeof createInitialData>): Mutate {
  return async (action, payload) => {
    if (action === "SELL_TICKETS") return sellTickets(data, payload.quantity!, crypto.randomUUID()) as never;
    if (action === "CONFIRM_HANDOVER") return confirmHandover(data, payload.kind!, payload.sourceId!, crypto.randomUUID()) as never;
    if (action === "HANDOVER_AND_CHECKIN") {
      const sale = data.sales.find((candidate) => candidate.id === payload.saleId)!;
      confirmHandover(data, "SALE", sale.id, crypto.randomUUID());
      return checkInTickets(data, sale.ticketNumbers, crypto.randomUUID()) as never;
    }
    throw new Error(`unexpected action ${action}`);
  };
}

describe("会計表示", () => {
  it("払い戻しを差し引いた値を最終金額として表示する", () => {
    const data = createDevelopmentData();
    const sale = sell(data, 2, 500, "accounting-screen");
    confirmHandover(data, "SALE", sale.saleId, "accounting-screen-handover");
    refundTickets(data, [1], "利用取りやめ", "accounting-screen-refund");
    const summary = getSummary(data);

    const { container, unmount } = render(<AccountingScreen data={data} summary={summary} />);
    const totalCards = [...container.querySelectorAll<HTMLElement>(".accounting-totals article")];
    const preRefund = totalCards.find((card) => card.textContent?.includes("販売金額"));
    const finalAmount = totalCards.find((card) => card.textContent?.includes("最終金額"));

    expect(preRefund).toHaveTextContent("200円");
    expect(finalAmount).toHaveTextContent("100円");
    expect(finalAmount).toHaveClass("profit");
    expect(screen.queryByText("払戻後残額")).not.toBeInTheDocument();
    unmount();

    render(
      <HomeScreen
        summary={summary}
        workspace={getActiveWorkspace(data)}
        onNavigate={() => undefined}
      />,
    );
    const homeFinalAmount = screen.getByText("最終金額").closest("article");
    expect(homeFinalAmount).toHaveTextContent("100円");
    expect(homeFinalAmount).toHaveTextContent("販売金額 200円から控除");
  });

  it("D1形式で現金台帳が空でも販売日へ払い戻しを反映する", () => {
    const data = createDevelopmentData();
    const sale = sell(data, 2, 500, "d1-daily-accounting");
    confirmHandover(data, "SALE", sale.saleId, "d1-daily-accounting-handover");
    refundTickets(data, [1], "利用取りやめ", "d1-daily-accounting-refund");
    data.cashLedger = [];

    const { container } = render(<AccountingScreen data={data} summary={getSummary(data)} />);
    const firstDay = [...container.querySelectorAll<HTMLElement>(".day-table .data-table__row")]
      .find((row) => row.textContent?.startsWith("1日目"));

    expect(firstDay).toHaveTextContent("1枚／100円");
    expect(firstDay).toHaveTextContent("100円");
  });
});

describe("管理画面の開催日", () => {
  it("D1運用回の3日分を具体的な日付で表示する", () => {
    const data = createInitialData();
    render(
      <AdminScreen
        data={data}
        mutate={async () => { throw new Error("unexpected mutation"); }}
        requestConfirmation={() => undefined}
      />,
    );

    expect(screen.getByText("2026年9月18日・2026年9月19日・2026年9月20日")).toBeVisible();
    expect(screen.getByText("開催日 2026年9月18日・2026年9月19日・2026年9月20日。営業状態を確認して運用してください。")).toBeVisible();
    expect(screen.queryByText(/開催日未設定/)).not.toBeInTheDocument();
  });
});

describe("販売直後の入場使用", () => {
  it("販売した全券の受渡しと入場をまとめて確定する", async () => {
    const data = createDevelopmentData();
    const requestConfirmation: RequestConfirmation = (_title, _description, action) => action();

    render(
      <SalesScreen
        data={data}
        summary={getSummary(data)}
        mutate={directMutate(data)}
        requestConfirmation={requestConfirmation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "人数をカートへ追加" }));
    fireEvent.click(screen.getByRole("button", { name: "販売確定・2枚を発番" }));

    expect(await screen.findByRole("button", { name: "購入した方がこのまま入場する（2枚）" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "券を渡して列に並んでもらう" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "購入した方がこのまま入場する（2枚）" }));

    await waitFor(() => expect(data.sales[0].handoverConfirmedAtMs).not.toBeNull());
    expect(data.tickets.map((ticket) => ticket.status)).toEqual(["USED", "USED"]);
    expect(data.admissions).toHaveLength(1);
    expect(data.admissions[0].ticketIds).toHaveLength(2);
    expect(data.ticketEvents.filter((event) => event.type === "CHECKIN")).toHaveLength(2);
    expect(screen.getByText("人数を入力")).toBeInTheDocument();
  });
});

describe("入場画面の一覧", () => {
  it.each(["1", "01", "001"])("%sをHC-001として受け付ける", (input) => {
    const data = createDevelopmentData();
    sell(data, 1, 100, `leading-${input}`);
    const { unmount } = render(
      <AdmissionScreen data={data} mutate={directMutate(data)} requestConfirmation={() => undefined} />,
    );
    const keypad = screen.getByLabelText("数字入力キーパッド");
    for (const digit of input) fireEvent.click(within(keypad).getByRole("button", { name: digit }));
    fireEvent.click(within(keypad).getByRole("button", { name: "番号を一覧へ追加" }));
    expect(screen.getByText("HC-001")).toBeVisible();
    unmount();
  });

  it("5枚以上でも一覧枠と確定ボタンを分離する", () => {
    const data = createDevelopmentData();
    sell(data, 6, 600, "admission-scroll");
    const requestConfirmation: RequestConfirmation = () => undefined;
    const { container } = render(
      <AdmissionScreen data={data} mutate={directMutate(data)} requestConfirmation={requestConfirmation} />,
    );

    for (const number of [1, 2, 3, 4, 5, 6]) {
      const keypad = screen.getByLabelText("数字入力キーパッド");
      fireEvent.click(within(keypad).getByRole("button", { name: String(number) }));
      fireEvent.click(within(keypad).getByRole("button", { name: "番号を一覧へ追加" }));
    }

    expect(container.querySelector(".operation-layout--checkin")).toBeInTheDocument();
    expect(container.querySelectorAll(".selected-ticket-list article")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "6枚を入場確定" })).toBeVisible();
  });
});
