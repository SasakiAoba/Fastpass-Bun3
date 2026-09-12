import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountingScreen } from "../src/client/screens/AccountingScreen";
import { AdmissionScreen } from "../src/client/screens/AdmissionScreen";
import { HomeScreen } from "../src/client/screens/HomeScreen";
import { SalesScreen } from "../src/client/screens/SalesScreen";
import type { Mutate, RequestConfirmation } from "../src/client/uiTypes";
import {
  confirmHandover,
  checkInTickets,
  createCheckout,
  enableDeveloperMode,
  finalizeSale,
  getActiveWorkspace,
  getSummary,
  refundTickets,
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
  tenderedYen: number,
  id: string,
) {
  const checkout = createCheckout(data, quantity, `${id}-hold`);
  return finalizeSale(data, checkout.id, tenderedYen, `${id}-sale`);
}

function directMutate(data: ReturnType<typeof createInitialData>): Mutate {
  return async (action, payload) => {
    if (action === "CREATE_CHECKOUT") return createCheckout(data, payload.quantity!, crypto.randomUUID()) as never;
    if (action === "FINALIZE_SALE") return finalizeSale(data, payload.checkoutId!, payload.tenderedYen!, crypto.randomUUID()) as never;
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
    const preRefund = totalCards.find((card) => card.textContent?.includes("売上金額（払戻前）"));
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
    expect(homeFinalAmount).toHaveTextContent("払戻前 200円");
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
        nowMs={Date.now()}
        mutate={directMutate(data)}
        requestConfirmation={requestConfirmation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "人数をカートへ追加" }));
    fireEvent.click(screen.getByRole("button", { name: "会計へ進む・2枚を確保" }));
    await screen.findByRole("button", { name: "ちょうど 200円" });
    fireEvent.click(screen.getByRole("button", { name: "ちょうど 200円" }));
    fireEvent.click(screen.getByRole("button", { name: "会計確定・発番" }));

    expect(await screen.findByRole("button", { name: "このまま入場使用（2枚）" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "このまま入場使用（2枚）" }));

    await waitFor(() => expect(data.sales[0].handoverConfirmedAtMs).not.toBeNull());
    expect(data.tickets.map((ticket) => ticket.status)).toEqual(["USED", "USED"]);
    expect(data.admissions).toHaveLength(1);
    expect(data.admissions[0].ticketIds).toHaveLength(2);
    expect(data.ticketEvents.filter((event) => event.type === "CHECKIN")).toHaveLength(2);
    expect(screen.getByText("人数を入力")).toBeInTheDocument();
  });
});

describe("入場画面の一覧", () => {
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
