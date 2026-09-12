import { formatYen } from "../../domain/format";
import type { Summary, Workspace } from "../../domain/types";
import type { ScreenName } from "../uiTypes";

type HomeScreenProps = {
  summary: Summary;
  workspace: Workspace;
  onNavigate: (screen: ScreenName) => void;
};

export function HomeScreen({ summary, workspace, onNavigate }: HomeScreenProps) {
  const cards = [
    { label: "本日の販売", value: `${summary.soldToday}枚`, meta: summary.dailyLimit === null ? "上限なし（テスト）" : `上限 ${summary.dailyLimit}枚` },
    { label: "全体販売", value: `${summary.totalSold}枚`, meta: `払い戻し ${summary.totalRefunded}枚` },
    { label: "未使用", value: `${summary.issuedCount}枚`, meta: `使用済み ${summary.usedCount}枚` },
    { label: "もらったお金", value: formatYen(summary.totalTenderedYen), meta: `${summary.checkoutCount}件の会計` },
    { label: "お釣り", value: formatYen(summary.totalChangeYen), meta: "販売時の合計" },
    { label: "最終利益", value: formatYen(summary.finalProfitYen), meta: `払戻後 ${formatYen(summary.netSalesYen)}` },
  ];

  return (
    <div className="screen home-screen">
      <section className="welcome-panel">
        <div>
          <p className="eyebrow">運用回 {workspace.sequence}・{summary.dayNumber}日目</p>
          <h2>受付を始めます</h2>
          <p>現金と木製チケットを確認し、操作を選んでください。</p>
        </div>
        <div className="home-primary-actions">
          <button type="button" className="launch-button launch-button--sales" onClick={() => onNavigate("sales")}>
            <span aria-hidden="true">¥</span>
            <strong>販売窓口</strong>
            <small>人数・会計・発番</small>
          </button>
          <button type="button" className="launch-button launch-button--entry" onClick={() => onNavigate("admission")}>
            <span aria-hidden="true">✓</span>
            <strong>入場受付</strong>
            <small>券番号・使用登録</small>
          </button>
        </div>
      </section>
      <section aria-labelledby="summary-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">現在の状況</p>
            <h2 id="summary-title">販売・会計概要</h2>
          </div>
          <p className="quiet">表示中の領域：{workspace.kind === "DEV" ? "テストデータ" : "本番データ"}</p>
        </div>
        <div className="metric-grid">
          {cards.map((card) => (
            <article className="metric-card" key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.meta}</small>
            </article>
          ))}
        </div>
      </section>
      <section className="home-secondary-actions" aria-label="その他の操作">
        <button type="button" onClick={() => onNavigate("accounting")}><strong>会計</strong><span>受取・お釣り・利益</span></button>
        <button type="button" onClick={() => onNavigate("records")}><strong>記録</strong><span>券・販売・履歴</span></button>
        <button type="button" onClick={() => onNavigate("admin")}><strong>管理</strong><span>営業・テスト・リセット</span></button>
      </section>
    </div>
  );
}
