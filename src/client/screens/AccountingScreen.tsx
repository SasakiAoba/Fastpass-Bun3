import { useMemo, useState } from "react";
import { NumericKeypad } from "../components/NumericKeypad";
import {
  addCashCount,
  addCashMovement,
  addExpense,
  cancelExpense,
  confirmExpenses,
  getActiveWorkspace,
} from "../../domain/engine";
import { formatDateTime, formatYen } from "../../domain/format";
import type { CashMovementType, FastpassData, Summary } from "../../domain/types";
import type { Commit, RequestReauth } from "../uiTypes";

type AccountingAction = "OPENING_FLOAT" | "TOP_UP" | "COLLECTION" | "EXPENSE" | "CASH_COUNT";

type AccountingScreenProps = {
  data: FastpassData;
  summary: Summary;
  commit: Commit;
  requestReauth: RequestReauth;
};

const ACTIONS: Array<{ id: AccountingAction; label: string; description: string }> = [
  { id: "OPENING_FLOAT", label: "釣銭準備金", description: "営業開始時の現金を追加" },
  { id: "TOP_UP", label: "現金補充", description: "レジへ現金を補充" },
  { id: "COLLECTION", label: "売上金回収", description: "レジから現金を回収" },
  { id: "EXPENSE", label: "経費登録", description: "材料費などを記録" },
  { id: "CASH_COUNT", label: "現金実査", description: "実際の現金を照合" },
];

export function AccountingScreen({ data, summary, commit, requestReauth }: AccountingScreenProps) {
  const [action, setAction] = useState<AccountingAction>("OPENING_FLOAT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("営業開始");
  const [category, setCategory] = useState("木製券・材料費");
  const [paymentSource, setPaymentSource] = useState<"CASHBOX" | "OUTSIDE">("CASHBOX");
  const workspace = getActiveWorkspace(data);

  const activeExpenses = useMemo(
    () => data.expenses.filter((expense) => expense.workspaceId === workspace.id && expense.cancelledAtMs === null),
    [data.expenses, workspace.id],
  );
  const totalExpenses = activeExpenses.reduce((sum, expense) => sum + expense.amountYen, 0);
  const difference = summary.netSalesYen - totalExpenses;

  const dayRows = ([1, 2, 3] as const).map((dayNumber) => {
    const sales = data.sales.filter((sale) => sale.workspaceId === workspace.id && sale.dayNumber === dayNumber);
    const refundEntries = data.cashLedger.filter(
      (entry) => entry.workspaceId === workspace.id && entry.type === "REFUND" && entry.dayNumber === dayNumber,
    );
    return {
      dayNumber,
      limit: workspace.kind === "DEV" ? null : workspace.businessDays[dayNumber].ticketLimit,
      sold: workspace.businessDays[dayNumber].soldCount,
      checkouts: sales.length,
      gross: sales.reduce((sum, sale) => sum + sale.totalYen, 0),
      refunds: Math.abs(refundEntries.reduce((sum, entry) => sum + entry.amountYen, 0)),
    };
  });

  const selectAction = (next: AccountingAction) => {
    setAction(next);
    setAmount("");
    setReason(
      next === "OPENING_FLOAT"
        ? "営業開始"
        : next === "TOP_UP"
          ? "釣銭補充"
          : next === "COLLECTION"
            ? "売上金回収"
            : next === "CASH_COUNT"
              ? "定時確認"
              : "材料購入",
    );
  };

  const record = () => {
    const value = Number(amount);
    const label = ACTIONS.find((candidate) => candidate.id === action)?.label ?? "会計操作";
    requestReauth(label, `${formatYen(value)}を記録します。元の記録は後から削除せず、訂正履歴を残します。`, () => {
      let result: unknown;
      if (action === "EXPENSE") {
        result = commit(
          (draft) => addExpense(draft, value, category, paymentSource, reason, crypto.randomUUID()),
          `${category} ${formatYen(value)}を登録しました。`,
        );
      } else if (action === "CASH_COUNT") {
        result = commit(
          (draft) => addCashCount(draft, value, crypto.randomUUID()),
          `実査額${formatYen(value)}を記録しました。`,
        );
      } else {
        result = commit(
          (draft) => addCashMovement(draft, action as Exclude<CashMovementType, "SALE" | "REFUND" | "EXPENSE" | "REVERSAL">, value, reason, crypto.randomUUID()),
          `${label} ${formatYen(value)}を記録しました。`,
        );
      }
      if (result !== null) setAmount("");
    });
  };

  const markExpensesConfirmed = () => {
    requestReauth("経費を確認済みにする", "経費が0円の場合も含め、現在の登録内容を確認済みにします。", () => {
      commit((draft) => confirmExpenses(draft, crypto.randomUUID()), "経費を確認済みにしました。");
    });
  };

  const requestCancelExpense = (expenseId: string, amountYen: number) => {
    requestReauth("経費記録を取り消す", `${formatYen(amountYen)}の経費を反対記録で取り消します。`, () => {
      commit(
        (draft) => cancelExpense(draft, expenseId, "登録訂正", crypto.randomUUID()),
        "元の経費を残し、取消記録を追加しました。",
      );
    });
  };

  return (
    <div className="screen accounting-screen">
      <section className="accounting-hero">
        <div><p className="eyebrow">会計・現金</p><h2>ファストパス収支</h2></div>
        <div className="accounting-totals">
          <article><span>純売上</span><strong>{formatYen(summary.netSalesYen)}</strong></article>
          <article><span>登録経費</span><strong>{formatYen(totalExpenses)}</strong></article>
          <article className={workspace.expensesConfirmedAtMs ? "positive" : "unconfirmed"}>
            <span>収支差額</span>
            <strong>{workspace.expensesConfirmedAtMs ? formatYen(difference) : "未算出"}</strong>
            <small>{workspace.expensesConfirmedAtMs ? `確認 ${formatDateTime(workspace.expensesConfirmedAtMs)}` : "経費未確認"}</small>
          </article>
          <article><span>予定現金残高</span><strong>{formatYen(summary.expectedCashYen)}</strong></article>
        </div>
      </section>

      <section className="day-accounting-table" aria-labelledby="day-accounting-title">
        <div className="section-heading"><div><p className="eyebrow">1～3日目と全体</p><h2 id="day-accounting-title">日別集計</h2></div><button type="button" className="secondary-button" onClick={markExpensesConfirmed}>経費を確認済みにする</button></div>
        <div className="data-table day-table">
          <div className="data-table__head"><span>対象</span><span>上限</span><span>販売枚数</span><span>会計件数</span><span>売上</span><span>返金</span><span>純売上</span></div>
          {dayRows.map((row) => (
            <div className="data-table__row" key={row.dayNumber}>
              <strong>{row.dayNumber}日目</strong><span>{row.limit === null ? "無制限" : `${row.limit}枚`}</span><span>{row.sold}枚</span><span>{row.checkouts}件</span><span>{formatYen(row.gross)}</span><span>{formatYen(row.refunds)}</span><strong>{formatYen(row.gross - row.refunds)}</strong>
            </div>
          ))}
        </div>
      </section>

      <div className="accounting-workspace">
        <section className="accounting-actions">
          <p className="eyebrow">記録する操作</p>
          <div className="action-choice-grid">
            {ACTIONS.map((item) => (
              <button type="button" key={item.id} className={action === item.id ? "active" : ""} onClick={() => selectAction(item.id)}>
                <strong>{item.label}</strong><span>{item.description}</span>
              </button>
            ))}
          </div>
          <div className="form-section accounting-form">
            {action === "EXPENSE" && (
              <>
                <label><span>分類</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option>木製券・材料費</option><option>印刷費</option><option>装飾費</option><option>その他</option></select></label>
                <label><span>支払元</span><select value={paymentSource} onChange={(event) => setPaymentSource(event.target.value as "CASHBOX" | "OUTSIDE")}><option value="CASHBOX">レジから支払った</option><option value="OUTSIDE">レジ外で支払済み</option></select></label>
              </>
            )}
            <label><span>理由</span><select value={reason} onChange={(event) => setReason(event.target.value)}><option>{reason}</option><option>営業開始</option><option>釣銭補充</option><option>売上金回収</option><option>材料購入</option><option>定時確認</option><option>登録訂正</option><option>その他</option></select></label>
          </div>
          <div className="number-display compact-number-display"><span>{action === "CASH_COUNT" ? "実際の現金残高" : "金額"}</span><strong>{amount ? formatYen(Number(amount)) : "0円"}</strong></div>
        </section>
        <aside className="accounting-keypad">
          <NumericKeypad value={amount} onChange={setAmount} onConfirm={record} confirmLabel={`${ACTIONS.find((item) => item.id === action)?.label ?? "操作"}を記録`} maxDigits={6} />
        </aside>
      </div>

      <section className="expense-list-section">
        <div className="section-heading"><div><p className="eyebrow">削除せず履歴を保持</p><h2>有効な経費</h2></div></div>
        {activeExpenses.length === 0 ? <p className="empty-inline">経費は登録されていません。</p> : (
          <div className="data-table">
            <div className="data-table__head expense-columns"><span>日時</span><span>分類</span><span>支払元</span><span>金額</span><span>操作</span></div>
            {activeExpenses.map((expense) => (
              <div className="data-table__row expense-columns" key={expense.id}><span>{formatDateTime(expense.occurredAtMs)}</span><strong>{expense.category}</strong><span>{expense.paymentSource === "CASHBOX" ? "レジ" : "レジ外"}</span><strong>{formatYen(expense.amountYen)}</strong><button type="button" className="text-button danger-text" onClick={() => requestCancelExpense(expense.id, expense.amountYen)}>取消</button></div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
