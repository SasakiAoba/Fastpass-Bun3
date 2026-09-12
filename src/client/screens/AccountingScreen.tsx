import { getActiveWorkspace } from "../../domain/engine";
import { formatYen } from "../../domain/format";
import type { FastpassData, Refund, Sale, Summary } from "../../domain/types";

type AccountingScreenProps = {
  data: FastpassData;
  summary: Summary;
};

type AccountingRow = {
  label: string;
  soldCount: number;
  checkoutCount: number;
  tenderedYen: number;
  changeYen: number;
  finalProfitYen: number;
  refundedCount: number;
  refundsYen: number;
  afterRefundYen: number;
};

function calculateRow(label: string, sales: Sale[], refunds: Refund[]): AccountingRow {
  const tenderedYen = sales.reduce((sum, sale) => sum + sale.tenderedYen, 0);
  const changeYen = sales.reduce((sum, sale) => sum + sale.changeYen, 0);
  const finalProfitYen = tenderedYen - changeYen;
  const refundsYen = refunds.reduce((sum, refund) => sum + refund.totalYen, 0);
  return {
    label,
    soldCount: sales.reduce((sum, sale) => sum + sale.quantity, 0),
    checkoutCount: sales.length,
    tenderedYen,
    changeYen,
    finalProfitYen,
    refundedCount: refunds.reduce((sum, refund) => sum + refund.ticketIds.length, 0),
    refundsYen,
    afterRefundYen: finalProfitYen - refundsYen,
  };
}

export function AccountingScreen({ data, summary }: AccountingScreenProps) {
  const workspace = getActiveWorkspace(data);
  const workspaceSales = data.sales.filter((sale) => sale.workspaceId === workspace.id);
  const workspaceRefunds = data.refunds.filter((refund) => refund.workspaceId === workspace.id);
  const saleDayById = new Map(workspaceSales.map((sale) => [sale.id, sale.dayNumber]));
  const ticketDayById = new Map(
    data.tickets
      .filter((ticket) => ticket.workspaceId === workspace.id)
      .map((ticket) => [ticket.id, saleDayById.get(ticket.saleId)]),
  );

  const dayRows = ([1, 2, 3] as const).map((dayNumber) => {
    return calculateRow(
      `${dayNumber}日目`,
      workspaceSales.filter((sale) => sale.dayNumber === dayNumber),
      workspaceRefunds.filter((refund) =>
        refund.ticketIds.some((ticketId) => ticketDayById.get(ticketId) === dayNumber),
      ),
    );
  });

  const overall = calculateRow("全期間", workspaceSales, workspaceRefunds);

  return (
    <div className="screen accounting-screen">
      <section className="accounting-hero">
        <div>
          <p className="eyebrow">会計・自動集計</p>
          <h2>ファストパス売上</h2>
          <p>販売時に記録した金額から自動計算します。</p>
        </div>
        <div className="accounting-totals">
          <article><span>もらったお金</span><strong>{formatYen(summary.totalTenderedYen)}</strong></article>
          <article><span>お釣り</span><strong>{formatYen(summary.totalChangeYen)}</strong></article>
          <article><span>売上金額（払戻前）</span><strong>{formatYen(summary.finalProfitYen)}</strong><small>もらったお金 − お釣り</small></article>
          <article className="profit"><span>最終金額</span><strong>{formatYen(summary.netSalesYen)}</strong><small>売上金額 − 払い戻し</small></article>
        </div>
      </section>

      <section className="accounting-counts" aria-label="販売と払い戻しの件数">
        <article><span>販売枚数</span><strong>{summary.totalSold}枚</strong></article>
        <article><span>会計件数</span><strong>{summary.checkoutCount}件</strong></article>
        <article><span>払い戻し</span><strong>{summary.totalRefunded}枚</strong><small>{formatYen(summary.refundsYen)}</small></article>
      </section>

      <section className="day-accounting-table" aria-labelledby="day-accounting-title">
        <div className="section-heading">
          <div><p className="eyebrow">1～3日目と全期間</p><h2 id="day-accounting-title">日別集計</h2></div>
          <p className="quiet">金額の手入力や経費登録はありません。</p>
        </div>
        <div className="data-table day-table">
          <div className="data-table__head">
            <span>対象</span><span>販売枚数</span><span>会計件数</span><span>もらったお金</span><span>お釣り</span><span>売上金額</span><span>払い戻し</span><span>最終金額</span>
          </div>
          {[...dayRows, overall].map((row) => (
            <div className={`data-table__row ${row.label === "全期間" ? "total-row" : ""}`} key={row.label}>
              <strong>{row.label}</strong>
              <span>{row.soldCount}枚</span>
              <span>{row.checkoutCount}件</span>
              <span>{formatYen(row.tenderedYen)}</span>
              <span>{formatYen(row.changeYen)}</span>
              <strong>{formatYen(row.finalProfitYen)}</strong>
              <span>{row.refundedCount}枚／{formatYen(row.refundsYen)}</span>
              <strong>{formatYen(row.afterRefundYen)}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="accounting-note" aria-label="計算方法">
        <div><strong>売上金額（払戻前）</strong><span>もらったお金 − お釣り</span></div>
        <div><strong>最終金額</strong><span>売上金額 − 払い戻し金額</span></div>
        <p>経費、釣銭準備金、現金補充、売上金回収、現金実査はこの画面では扱いません。</p>
      </section>
    </div>
  );
}
