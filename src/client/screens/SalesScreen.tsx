import { useEffect, useMemo, useState } from "react";
import { NumericKeypad } from "../components/NumericKeypad";
import { formatGroupNumber, formatTicketCode, formatYen } from "../../domain/format";
import type { Checkout, FastpassData, SaleResult, Summary } from "../../domain/types";
import type { Mutate, RequestConfirmation } from "../uiTypes";

type SalesScreenProps = {
  data: FastpassData;
  summary: Summary;
  nowMs: number;
  mutate: Mutate;
  requestConfirmation: RequestConfirmation;
};

export function SalesScreen({ data, summary, nowMs, mutate, requestConfirmation }: SalesScreenProps) {
  const [cartQuantity, setCartQuantity] = useState(0);
  const [numericValue, setNumericValue] = useState("");
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [result, setResult] = useState<SaleResult | null>(null);

  const totalYen = (checkout?.quantity ?? cartQuantity) * (checkout?.unitPriceYen ?? 100);
  const secondsRemaining = checkout ? Math.max(0, Math.ceil((checkout.expiresAtMs - nowMs) / 1000)) : 0;
  const liveCheckout = useMemo(
    () => checkout && data.checkouts.find((candidate) => candidate.id === checkout.id),
    [checkout, data.checkouts],
  );

  useEffect(() => {
    if (checkout && (!liveCheckout || liveCheckout.status !== "HELD" || secondsRemaining <= 0) && !result) {
      setCheckout(null);
      setNumericValue("");
      setCartQuantity(0);
    }
  }, [checkout, liveCheckout, result, secondsRemaining]);

  const addQuantity = () => {
    const quantity = Number(numericValue);
    if (!Number.isSafeInteger(quantity) || quantity < 1) return;
    if (cartQuantity + quantity > 200) return;
    setCartQuantity((current) => current + quantity);
    setNumericValue("");
  };

  const hold = async () => {
    const created = await mutate<Checkout>("CREATE_CHECKOUT", { quantity: cartQuantity }, `${cartQuantity}枚を一時確保しました。`);
    if (created) {
      setCheckout(created);
      setNumericValue("");
    }
  };

  const finalize = async () => {
    if (!checkout) return;
    const saleResult = await mutate<SaleResult>("FINALIZE_SALE", { checkoutId: checkout.id, tenderedYen: Number(numericValue) }, "販売と発番が完了しました。木製券と釣銭を確認してください。");
    if (saleResult) {
      setResult(saleResult);
      setNumericValue("");
    }
  };

  const cancel = async () => {
    if (!checkout) return;
    const cancelled = await mutate<{ cancelled: boolean }>("CANCEL_CHECKOUT", { checkoutId: checkout.id }, "一時確保を解除しました。");
    if (cancelled) {
      setCheckout(null);
      setCartQuantity(0);
      setNumericValue("");
    }
  };

  const resetSale = () => {
    setResult(null);
    setCheckout(null);
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
      "このまま入場使用",
      `今回販売した${currentResult.ticketNumbers.length}枚すべてを使用済みにします。実際に入場させることを確認してください。`,
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
          <p className="success-kicker">会計完了</p>
          <h2>{formatGroupNumber(result.groupNumber)}</h2>
          <dl className="money-breakdown">
            <div><dt>お会計</dt><dd>{formatYen(result.totalYen)}</dd></div>
            <div><dt>お預り</dt><dd>{formatYen(result.tenderedYen)}</dd></div>
            <div className="change-row"><dt>おつり</dt><dd>{formatYen(result.changeYen)}</dd></div>
          </dl>
          <div className="alert alert--warning">画面と実物を照合し、すべての券と釣銭を渡してから確認してください。</div>
          <div className="result-actions fixed-action">
              <button type="button" className="secondary-button" onClick={() => void completeHandoverAndCheckIn()}>
              このまま入場使用（{result.ticketNumbers.length}枚）
            </button>
            <button type="button" className="primary-button" onClick={() => void completeHandover()}>受渡しを確認して次の会計へ</button>
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
          <div><p className="eyebrow">販売窓口</p><h2>{checkout ? "預り金を入力" : "人数を入力"}</h2></div>
          <div className="capacity-chip">販売可能 {summary.availableToday === null ? "無制限" : `${summary.availableToday}枚`}</div>
        </div>
        {checkout ? (
          <>
            <div className="checkout-card">
              <span>ファストパス</span><strong>{checkout.quantity}枚</strong>
              <span>お会計</span><strong>{formatYen(totalYen)}</strong>
              <span>お預り</span><strong>{numericValue ? formatYen(Number(numericValue)) : "—"}</strong>
            </div>
            <div className={`hold-timer ${secondsRemaining <= 30 ? "hold-timer--urgent" : ""}`}>
              一時確保 残り <strong>{secondsRemaining}秒</strong>
            </div>
            {numericValue && Number(numericValue) < totalYen && (
              <div className="alert alert--danger">あと{formatYen(totalYen - Number(numericValue))}必要です。</div>
            )}
            <button type="button" className="secondary-button" onClick={() => void cancel()}>会計を取り消して確保を解除</button>
          </>
        ) : (
          <>
            <div className="cart-table">
              <div className="cart-head"><span>商品</span><span>枚数</span><span>単価</span><span>小計</span></div>
              <div className="cart-row"><strong>ファストパス</strong><strong>{cartQuantity}枚</strong><span>{formatYen(100)}</span><strong>{formatYen(cartQuantity * 100)}</strong></div>
            </div>
            <div className="cart-adjustments">
              <button type="button" onClick={() => setCartQuantity((current) => Math.max(0, current - 1))} disabled={cartQuantity === 0}>−1</button>
              <button type="button" onClick={() => setCartQuantity((current) => Math.min(200, current + 1))}>＋1</button>
              <button type="button" onClick={() => setCartQuantity(0)} disabled={cartQuantity === 0}>カートを空にする</button>
            </div>
            <div className="cart-total"><span>合計</span><strong>{formatYen(cartQuantity * 100)}</strong></div>
            <button type="button" className="primary-button fixed-action" onClick={() => void hold()} disabled={cartQuantity === 0}>会計へ進む・{cartQuantity}枚を確保</button>
          </>
        )}
      </section>
      <aside className="side-panel keypad-panel sales-keypad-panel">
        <div className="number-display" aria-live="polite">
          <span>{checkout ? "お預り" : "追加する人数"}</span>
          <strong>{numericValue || "0"}{checkout ? "円" : "人"}</strong>
        </div>
        <NumericKeypad
          value={numericValue}
          onChange={setNumericValue}
          onConfirm={checkout ? () => void finalize() : addQuantity}
          confirmLabel={checkout ? "会計確定・発番" : "人数をカートへ追加"}
          disabled={checkout ? secondsRemaining <= 0 : false}
          confirmDisabled={checkout ? Number(numericValue) < totalYen : cartQuantity + Number(numericValue || 0) > 200}
          maxDigits={checkout ? 6 : 3}
          quickExactValue={checkout ? totalYen : undefined}
        />
      </aside>
    </div>
  );
}
