import { useState } from "react";
import { NumericKeypad } from "../components/NumericKeypad";
import { formatGroupNumber, formatTicketCode, formatYen } from "../../domain/format";
import { getActiveWorkspace } from "../../domain/engine";
import type { FastpassData, SaleResult, Summary } from "../../domain/types";
import type { Mutate, RequestConfirmation } from "../uiTypes";

type SalesScreenProps = {
  data: FastpassData;
  summary: Summary;
  mutate: Mutate;
  requestConfirmation: RequestConfirmation;
};

export function SalesScreen({ data, summary, mutate, requestConfirmation }: SalesScreenProps) {
  const [cartQuantity, setCartQuantity] = useState(0);
  const [numericValue, setNumericValue] = useState("");
  const [result, setResult] = useState<SaleResult | null>(null);
  const unitPriceYen = getActiveWorkspace(data).configSnapshot.UNIT_PRICE_YEN;

  const addQuantity = () => {
    const quantity = Number(numericValue);
    if (!Number.isSafeInteger(quantity) || quantity < 1) return;
    if (cartQuantity + quantity > 200) return;
    setCartQuantity((current) => current + quantity);
    setNumericValue("");
  };

  const sell = async () => {
    const saleResult = await mutate<SaleResult>("SELL_TICKETS", { quantity: cartQuantity }, "販売と発番が完了しました。表示された番号と木製券を確認してください。");
    if (saleResult) {
      setResult(saleResult);
      setNumericValue("");
    }
  };

  const resetSale = () => {
    setResult(null);
    setCartQuantity(0);
    setNumericValue("");
  };

  const completeHandover = async () => {
    if (!result) return;
    const confirmed = await mutate<{ confirmed: boolean }>("CONFIRM_HANDOVER", { kind: "SALE", sourceId: result.saleId }, "受渡しを確認しました。次の会計を開始できます。");
    if (confirmed !== null) resetSale();
  };

  const completeHandoverAndCheckIn = () => {
    if (!result) return;
    const currentResult = result;
    requestConfirmation(
      "購入した方がこのまま入場する",
      `今回販売した${currentResult.ticketNumbers.length}枚すべてを使用済みにします。購入した方を今すぐ入場させる場合だけ確定してください。`,
      async () => {
        const admission = await mutate<{ admissionId: string }>("HANDOVER_AND_CHECKIN", { saleId: currentResult.saleId }, `${currentResult.ticketNumbers.length}枚の受渡しと入場使用を確定しました。`);
        if (admission) resetSale();
      },
    );
  };

  if (result) {
    return (
      <div className="screen two-column sales-result">
        <section className="work-panel result-summary">
          <p className="success-kicker">販売・発番完了</p>
          <h2>{formatGroupNumber(result.groupNumber)}</h2>
          <dl className="money-breakdown">
            <div><dt>販売金額</dt><dd>{formatYen(result.totalYen)}</dd></div>
          </dl>
          <div className="alert alert--warning">画面の番号と実物の券を照合し、すべての券を渡してから次の操作を選んでください。</div>
          <div className="result-actions fixed-action">
              <button type="button" className="secondary-button" onClick={() => void completeHandoverAndCheckIn()}>
              購入した方がこのまま入場する（{result.ticketNumbers.length}枚）
            </button>
            <button type="button" className="primary-button" onClick={() => void completeHandover()}>券を渡して列に並んでもらう</button>
          </div>
        </section>
        <aside className="side-panel issued-list">
          <p className="eyebrow">お渡しするチケット</p>
          <h2>{result.ticketNumbers.length}枚</h2>
          <div className="ticket-number-list">
            {result.ticketNumbers.map((number) => <strong key={number}>{formatTicketCode(number)}</strong>)}
          </div>
        </aside>
      </div>
    );
  }

  return (
    <div className="screen two-column">
      <section className="work-panel">
        <div className="section-heading compact-heading">
          <div><p className="eyebrow">販売窓口</p><h2>人数を入力</h2></div>
          <div className="capacity-chip">販売可能 {summary.availableToday === null ? "無制限" : `${summary.availableToday}枚`}</div>
        </div>
        <>
            <div className="cart-table">
              <div className="cart-head"><span>商品</span><span>枚数</span><span>単価</span><span>小計</span></div>
              <div className="cart-row"><strong>ファストパス</strong><strong>{cartQuantity}枚</strong><span>{formatYen(unitPriceYen)}</span><strong>{formatYen(cartQuantity * unitPriceYen)}</strong></div>
            </div>
            <div className="cart-adjustments">
              <button type="button" onClick={() => setCartQuantity((current) => Math.max(0, current - 1))} disabled={cartQuantity === 0}>−1</button>
              <button type="button" onClick={() => setCartQuantity((current) => Math.min(200, current + 1))}>＋1</button>
              <button type="button" onClick={() => setCartQuantity(0)} disabled={cartQuantity === 0}>カートを空にする</button>
            </div>
            <div className="cart-total"><span>販売金額</span><strong>{formatYen(cartQuantity * unitPriceYen)}</strong></div>
            <button type="button" className="primary-button fixed-action" onClick={() => void sell()} disabled={cartQuantity === 0}>販売確定・{cartQuantity}枚を発番</button>
          </>
      </section>
      <aside className="side-panel keypad-panel sales-keypad-panel">
        <div className="number-display" aria-live="polite">
          <span>追加する人数</span>
          <strong>{numericValue || "0"}人</strong>
        </div>
        <NumericKeypad
          value={numericValue}
          onChange={setNumericValue}
          onConfirm={addQuantity}
          confirmLabel="人数をカートへ追加"
          confirmDisabled={cartQuantity + Number(numericValue || 0) > 200}
          maxDigits={3}
        />
      </aside>
    </div>
  );
}
