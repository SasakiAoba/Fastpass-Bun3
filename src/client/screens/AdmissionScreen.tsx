import { useMemo, useState } from "react";
import { NumericKeypad } from "../components/NumericKeypad";
import {
  checkInTickets,
  confirmHandover,
  previewTickets,
  refundTickets,
  reverseCheckin,
} from "../../domain/engine";
import { formatDateTime, formatGroupNumber, formatTicketCode, formatYen } from "../../domain/format";
import type { FastpassData, Refund, TicketStatus } from "../../domain/types";
import type { Commit, RequestConfirmation } from "../uiTypes";

type OperationMode = "CHECKIN" | "REFUND" | "REVERSAL";

type AdmissionScreenProps = {
  data: FastpassData;
  commit: Commit;
  requestConfirmation: RequestConfirmation;
};

const STATUS_LABELS: Record<TicketStatus, string> = {
  ISSUED: "未使用",
  USED: "使用済み",
  REFUNDED: "払い戻し済み",
};

export function AdmissionScreen({ data, commit, requestConfirmation }: AdmissionScreenProps) {
  const [mode, setMode] = useState<OperationMode>("CHECKIN");
  const [numericValue, setNumericValue] = useState("");
  const [numbers, setNumbers] = useState<number[]>([]);
  const [reason, setReason] = useState("誤入力");
  const [recovered, setRecovered] = useState(false);
  const [refundResult, setRefundResult] = useState<Refund | null>(null);

  const workspaceId =
    data.system.mode === "DEVELOPMENT" ? data.system.devWorkspaceId : data.system.liveWorkspaceId;
  const tickets = useMemo(
    () =>
      numbers.map((number) => {
        const ticket = data.tickets.find(
          (candidate) => candidate.workspaceId === workspaceId && candidate.serialNumber === number,
        );
        const sale = ticket
          ? data.sales.find((candidate) => candidate.id === ticket.saleId && candidate.workspaceId === workspaceId)
          : undefined;
        return { number, ticket, sale };
      }),
    [data.sales, data.tickets, numbers, workspaceId],
  );

  const reset = (nextMode = mode) => {
    setMode(nextMode);
    setNumericValue("");
    setNumbers([]);
    setRecovered(false);
    setRefundResult(null);
    setReason(nextMode === "REFUND" ? "購入間違い" : "誤入力");
  };

  const switchMode = (nextMode: OperationMode) => reset(nextMode);

  const addNumber = () => {
    const number = Number(numericValue);
    if (!Number.isSafeInteger(number) || number < 1 || numbers.includes(number)) return;
    const preview = commit((draft) => previewTickets(draft, [number]));
    if (!preview) return;
    const status = preview[0].ticket.status;
    if (mode === "CHECKIN" && status !== "ISSUED") {
      commit(() => {
        throw new Error(`この券は${STATUS_LABELS[status]}のため入場一覧へ追加できません。`);
      });
      return;
    }
    if (mode === "REFUND" && status !== "ISSUED") {
      commit(() => {
        throw new Error(`この券は${STATUS_LABELS[status]}のため払い戻しできません。`);
      });
      return;
    }
    if (mode === "REVERSAL" && status !== "USED") {
      commit(() => {
        throw new Error("現在使用済みの券だけを取り消せます。");
      });
      return;
    }
    setNumbers((current) => (mode === "REVERSAL" ? [number] : [...current, number]));
    setNumericValue("");
  };

  const confirmCheckin = () => {
    const result = commit(
      (draft) => checkInTickets(draft, numbers, crypto.randomUUID()),
      `${numbers.length}枚の入場受付が完了しました。成功表示を確認してから入場させてください。`,
    );
    if (result) reset("CHECKIN");
  };

  const confirmRefund = () => {
    requestConfirmation(
      "払い戻しを確定",
      `${numbers.length}枚を払い戻します。木製券の回収と返金額を確認してください。`,
      () => {
        const refund = commit(
          (draft) => refundTickets(draft, numbers, reason, crypto.randomUUID()),
          "払い戻しを記録しました。現金を渡してから受渡確認を押してください。",
        );
        if (refund) setRefundResult(refund);
      },
    );
  };

  const confirmReversal = () => {
    const item = tickets[0];
    if (!item?.ticket?.currentUseEventId) return;
    const eventId = item.ticket.currentUseEventId;
    requestConfirmation(
      "使用済みを取り消す",
      `${formatTicketCode(item.number)}を未使用へ戻します。履歴は削除されません。`,
      () => {
        const completed = commit(
          (draft) => reverseCheckin(draft, item.number, reason, eventId, crypto.randomUUID()),
          `${formatTicketCode(item.number)}を未使用へ戻しました。`,
        );
        if (completed !== null) reset("CHECKIN");
      },
    );
  };

  const confirmRefundHandover = () => {
    if (!refundResult) return;
    const done = commit(
      (draft) => confirmHandover(draft, "REFUND", refundResult.id, crypto.randomUUID()),
      "返金の受渡しを確認しました。",
    );
    if (done !== null) reset("CHECKIN");
  };

  if (refundResult) {
    return (
      <div className="screen centered-screen">
        <section className="result-dialog">
          <p className="success-kicker">払い戻し記録完了</p>
          <h2>返金額</h2>
          <strong className="refund-total">{formatYen(refundResult.totalYen)}</strong>
          <p>{refundResult.ticketIds.length}枚分です。係員が現金を渡した後に、受渡しを確認してください。</p>
          <div className="alert alert--warning">通信や画面操作を繰り返して、現金を二重に渡さないでください。</div>
          <button type="button" className="primary-button" onClick={confirmRefundHandover}>返金受渡しを確認</button>
        </section>
      </div>
    );
  }

  const title = mode === "CHECKIN" ? "入場受付" : mode === "REFUND" ? "払い戻し" : "使用済み取消";
  const validForConfirmation = numbers.length > 0 && (mode !== "REFUND" || recovered);

  return (
    <div className="screen">
      <div className="operation-tabs" role="tablist" aria-label="受付操作">
        <button type="button" role="tab" aria-selected={mode === "CHECKIN"} className={mode === "CHECKIN" ? "active" : ""} onClick={() => switchMode("CHECKIN")}>入場受付</button>
        <button type="button" role="tab" aria-selected={mode === "REVERSAL"} className={mode === "REVERSAL" ? "active" : ""} onClick={() => switchMode("REVERSAL")}>使用取消</button>
        <button type="button" role="tab" aria-selected={mode === "REFUND"} className={mode === "REFUND" ? "active" : ""} onClick={() => switchMode("REFUND")}>払い戻し</button>
      </div>
      <div className="two-column operation-layout">
        <section className="work-panel">
          <div className="section-heading compact-heading">
            <div><p className="eyebrow">{mode === "CHECKIN" ? "提示された券だけを登録" : "実行前に内容を確認"}</p><h2>{title}</h2></div>
            <strong className="selection-count">{numbers.length}枚</strong>
          </div>
          {numbers.length === 0 ? (
            <div className="empty-state"><span aria-hidden="true">▤</span><strong>番号を入力してください</strong><p>一覧へ追加しただけでは状態は変わりません。</p></div>
          ) : (
            <div className="selected-ticket-list">
              {tickets.map(({ number, ticket, sale }) => (
                <article key={number}>
                  <div><strong>{formatTicketCode(number)}</strong><span>{ticket ? STATUS_LABELS[ticket.status] : "確認中"}</span></div>
                  <div><span>{sale ? formatGroupNumber(sale.groupNumber) : "—"}</span><span>{ticket?.usedAtMs ? `使用 ${formatDateTime(ticket.usedAtMs)}` : ""}</span></div>
                  <button type="button" onClick={() => setNumbers((current) => current.filter((value) => value !== number))} aria-label={`${formatTicketCode(number)}を一覧から削除`}>削除</button>
                </article>
              ))}
            </div>
          )}
          {mode !== "CHECKIN" && numbers.length > 0 && (
            <div className="form-section">
              <label>
                <span>理由</span>
                <select value={reason} onChange={(event) => setReason(event.target.value)}>
                  {(mode === "REFUND"
                    ? ["購入間違い", "利用取りやめ", "係員操作ミス", "その他"]
                    : ["誤入力", "入場前の操作ミス", "その他"]
                  ).map((option) => <option key={option}>{option}</option>)}
                </select>
              </label>
              {mode === "REFUND" && (
                <label className="check-row"><input type="checkbox" checked={recovered} onChange={(event) => setRecovered(event.target.checked)} /><span>木製チケットを回収した</span></label>
              )}
            </div>
          )}
          <button
            type="button"
            className="primary-button fixed-action"
            disabled={!validForConfirmation}
            onClick={mode === "CHECKIN" ? confirmCheckin : mode === "REFUND" ? confirmRefund : confirmReversal}
          >
            {mode === "CHECKIN" ? `${numbers.length}枚を入場確定` : mode === "REFUND" ? `${numbers.length}枚の払い戻し確認へ` : "使用済みを取り消す"}
          </button>
        </section>
        <aside className="side-panel">
          <div className="number-display"><span>番号入力</span><strong>HC-{numericValue || "___"}</strong></div>
          <NumericKeypad value={numericValue} onChange={setNumericValue} onConfirm={addNumber} confirmLabel="番号を一覧へ追加" maxDigits={8} />
        </aside>
      </div>
    </div>
  );
}
