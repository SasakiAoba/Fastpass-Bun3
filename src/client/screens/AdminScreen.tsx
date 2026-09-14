import { useState } from "react";
import { type DayNumber } from "../../config/fastpass.config";
import { getActiveWorkspace } from "../../domain/engine";
import { formatDateTime } from "../../domain/format";
import type { FastpassData } from "../../domain/types";
import { downloadD1Export } from "../../infrastructure/apiClient";
import type { Mutate, RequestConfirmation } from "../uiTypes";

type AdminScreenProps = {
  data: FastpassData;
  mutate: Mutate;
  requestConfirmation: RequestConfirmation;
};

export function AdminScreen({ data, mutate, requestConfirmation }: AdminScreenProps) {
  const workspace = getActiveWorkspace(data);
  const [deviceName, setDeviceName] = useState(data.system.device.name);
  const isPreview = data.system.environment === "preview";
  const isDev = data.system.mode === "DEVELOPMENT";
  const eventDates = ([1, 2, 3] as const).map((day) => workspace.businessDays[day]?.eventDate ?? null);
  const eventDateLabel = eventDates.every((date): date is string => date !== null)
    ? eventDates.map((date) => {
      const [year, month, day] = date.split("-").map(Number);
      return `${year}年${month}月${day}日`;
    }).join("・")
    : "開催日が未設定です";

  const confirmAction = (title: string, description: string, action: () => void) => {
    requestConfirmation(title, description, action);
  };

  const toggleMaintenance = () => {
    const next = !data.system.maintenance;
    confirmAction(next ? "営業を停止" : "営業を再開", next ? "全ての新規業務操作を停止します。記録と会計は閲覧できます。" : "現在の領域で受付操作を再開します。モードと設定を確認してください。", () => {
      void mutate("SET_MAINTENANCE", { maintenance: next }, next ? "営業を停止しました。" : "営業を再開しました。");
    });
  };

  const startDevelopment = () => {
    confirmAction("開発者モードを開始", "すべての受付画面をテストデータ領域へ切り替えます。実物の券と現金は扱わないでください。", () => {
      void mutate("ENABLE_DEVELOPER_MODE", {}, "開発者モードを開始しました。日別・総発行上限は適用されません。");
    });
  };

  const stopDevelopment = () => {
    confirmAction("テストデータを削除", "現在のDEV領域にあるチケット、販売、入場、返金、現金、履歴を削除します。本番データは保持します。", () => {
      void mutate("DISABLE_DEVELOPER_MODE", {}, isPreview ? "テストデータを削除しました。Previewはテスト停止中です。" : "DEVデータを削除しました。本番の営業停止状態です。");
    });
  };

  const resetLive = () => {
    confirmAction("本番運用回をリセット", "現在の本番運用回を保存し、新しい運用回を作成します。番号と会計は0から始まります。", () => {
      void mutate("RESET_LIVE_WORKSPACE", {}, "新しい本番運用回を作成しました。");
    });
  };

  const updateDeviceName = async () => {
    await mutate("RENAME_DEVICE", { name: deviceName }, "端末名を変更しました。");
  };

  const setDay = (day: DayNumber) => {
    void mutate("SET_DEVELOPER_DAY", { dayNumber: day }, `テスト日を${day}日目に変更しました。`);
  };

  const exportFile = (kind: "json" | "tickets" | "sales" | "refunds" | "audit") => {
    downloadD1Export(kind);
  };

  return (
    <div className="screen admin-screen">
      <section className="admin-status-grid">
        <article className={isDev ? "admin-status admin-status--dev" : "admin-status admin-status--live"}>
          <p className="eyebrow">現在の領域</p><h2>{isDev ? "開発者モード" : isPreview ? "テスト停止中" : "本番モード"}</h2><strong>運用回 {workspace.sequence}</strong><p>{isDev ? "終了時にこのテスト業務データを削除します。" : `開催日 ${eventDateLabel}。営業状態を確認して運用してください。`}</p>
        </article>
        <article className={`admin-status ${data.system.maintenance ? "admin-status--stopped" : "admin-status--open"}`}>
          <p className="eyebrow">営業状態</p><h2>{data.system.maintenance ? "営業停止中" : "受付可能"}</h2><p>モード世代 {data.system.modeEpoch}</p><button type="button" className={data.system.maintenance ? "primary-button" : "danger-button"} disabled={isPreview && !isDev} onClick={toggleMaintenance}>{data.system.maintenance ? "営業を再開" : "営業を停止"}</button>
        </article>
      </section>

      {isDev && (
        <section className="dev-day-panel">
          <div><p className="eyebrow">テスト集計だけに作用</p><h2>開発者モードの日付</h2></div>
          <div className="segmented-control" role="group" aria-label="テスト日">
            {([1, 2, 3] as const).map((day) => <button type="button" key={day} className={workspace.selectedTestDay === day ? "active" : ""} onClick={() => setDay(day)}>{day}日目</button>)}
          </div>
        </section>
      )}

      <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">通常の受付操作から分離</p><h2>モードと運用回</h2></div></div>
        <div className="admin-action-grid">
          {!isDev ? (
            <button type="button" onClick={startDevelopment}><strong>開発者モードを有効にする</strong><span>専用テスト領域を001から開始</span></button>
          ) : (
            <button type="button" className="danger-card" onClick={stopDevelopment}><strong>開発者モードを終了</strong><span>現在のテスト業務データを削除</span></button>
          )}
          <button type="button" className="danger-card" onClick={resetLive} disabled={isPreview || isDev || !data.system.maintenance}><strong>本番運用回をリセット</strong><span>営業停止・開催終了確認が必要</span></button>
        </div>
      </section>

      <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">D1運用回に固定保存</p><h2>有効な設定</h2></div><span className="status-pill status-pill--done">設定読込済み</span></div>
        <div className="config-grid">
          <div><span>表示番号</span><strong>{workspace.configSnapshot.TICKET_PREFIX}001～{workspace.configSnapshot.TICKET_PREFIX}{String(workspace.configSnapshot.MAX_TICKET_NUMBER).padStart(3, "0")}</strong></div>
          <div><span>単価</span><strong>{workspace.configSnapshot.UNIT_PRICE_YEN}円</strong></div>
          <div><span>日別上限</span><strong>各日 {workspace.configSnapshot.DAILY_TICKET_LIMITS[1]}枚（仮値）</strong></div>
          <div><span>開催日</span><strong>{eventDateLabel}</strong></div>
          <div><span>仮確保</span><strong>{workspace.configSnapshot.CHECKOUT_HOLD_SECONDS}秒</strong></div>
          <div><span>最終保存</span><strong>{formatDateTime(data.savedAtMs)}</strong></div>
        </div>
      </section>

      <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">操作履歴に記録される識別名</p><h2>この端末</h2></div></div>
        <div className="inline-form"><label className="text-field"><span>端末名</span><input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={100} /></label><button type="button" className="secondary-button" onClick={() => void updateDeviceName()} disabled={deviceName.trim() === data.system.device.name}>端末名を保存</button></div>
      </section>

      <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">認証情報を含めません</p><h2>本番データ出力</h2></div></div>
        {isPreview || isDev ? <div className="alert alert--warning">テスト環境では正式な本番業務出力を無効にしています。</div> : (
          <div className="export-grid">
            <button type="button" onClick={() => exportFile("json")}>本番JSON</button>
            <button type="button" onClick={() => exportFile("tickets")}>チケットCSV</button>
            <button type="button" onClick={() => exportFile("sales")}>販売CSV</button>
            <button type="button" onClick={() => exportFile("refunds")}>払戻CSV</button>
            <button type="button" onClick={() => exportFile("audit")}>操作履歴CSV</button>
          </div>
        )}
        <p className="field-note">表示中のD1本番運用回をサーバーから直接出力します。共有パスワード、Cookie、セッション情報は含みません。</p>
      </section>
    </div>
  );
}
