import { useRef, useState, type ChangeEvent } from "react";
import { FASTPASS_CONFIG, validateConfig, type DayNumber } from "../../config/fastpass.config";
import {
  disableDeveloperMode,
  enableDeveloperMode,
  getActiveWorkspace,
  renameDevice,
  resetLiveWorkspace,
  setDeveloperDay,
  setMaintenance,
} from "../../domain/engine";
import { downloadText, formatDateTime } from "../../domain/format";
import type { FastpassData } from "../../domain/types";
import {
  auditCsv,
  refundsCsv,
  salesCsv,
  ticketsCsv,
  workspaceJson,
} from "../../infrastructure/exportData";
import type { Commit, RequestConfirmation } from "../uiTypes";

type AdminScreenProps = {
  data: FastpassData;
  commit: Commit;
  requestConfirmation: RequestConfirmation;
  onRestore: (raw: string) => boolean;
};

export function AdminScreen({ data, commit, requestConfirmation, onRestore }: AdminScreenProps) {
  const workspace = getActiveWorkspace(data);
  const [deviceName, setDeviceName] = useState(data.system.device.name);
  const fileInput = useRef<HTMLInputElement>(null);
  const configErrors = validateConfig(FASTPASS_CONFIG);
  const isDev = data.system.mode === "DEVELOPMENT";

  const confirmAction = (title: string, description: string, action: () => void) => {
    requestConfirmation(title, description, action);
  };

  const toggleMaintenance = () => {
    const next = !data.system.maintenance;
    confirmAction(next ? "営業を停止" : "営業を再開", next ? "全ての新規業務操作を停止します。記録と会計は閲覧できます。" : "現在の領域で受付操作を再開します。モードと設定を確認してください。", () => {
      commit((draft) => setMaintenance(draft, next), next ? "営業を停止しました。" : "営業を再開しました。");
    });
  };

  const startDevelopment = () => {
    confirmAction("開発者モードを開始", "すべての受付画面をテストデータ領域へ切り替えます。実物の券と現金は扱わないでください。", () => {
      commit((draft) => enableDeveloperMode(draft), "開発者モードを開始しました。日別・総発行上限は適用されません。");
    });
  };

  const stopDevelopment = () => {
    confirmAction("テストデータを削除", "現在のDEV領域にあるチケット、販売、入場、返金、現金、履歴を削除します。本番データは保持します。", () => {
      commit((draft) => disableDeveloperMode(draft), "DEVデータを削除しました。本番の営業停止状態です。");
    });
  };

  const resetLive = () => {
    confirmAction("本番運用回をリセット", "現在の本番運用回を保存し、新しい運用回を作成します。番号と会計は0から始まります。", () => {
      commit((draft) => resetLiveWorkspace(draft), "新しい本番運用回を作成しました。");
    });
  };

  const updateDeviceName = () => {
    commit((draft) => renameDevice(draft, deviceName), "端末名を変更しました。");
  };

  const setDay = (day: DayNumber) => {
    commit((draft) => setDeveloperDay(draft, day), `テスト日を${day}日目に変更しました。`);
  };

  const exportFile = (kind: "json" | "tickets" | "sales" | "refunds" | "audit") => {
    const prefix = `fastpass-live-${workspace.sequence}-${new Date().toISOString().slice(0, 10)}`;
    const exporters = {
      json: () => workspaceJson(data, workspace.id),
      tickets: () => ticketsCsv(data, workspace.id),
      sales: () => salesCsv(data, workspace.id),
      refunds: () => refundsCsv(data, workspace.id),
      audit: () => auditCsv(data, workspace.id),
    };
    downloadText(`${prefix}-${kind}.${kind === "json" ? "json" : "csv"}`, exporters[kind](), kind === "json" ? "application/json" : "text/csv;charset=utf-8");
  };

  const backupAll = () => {
    downloadText(
      `fastpass-local-backup-${new Date().toISOString().replaceAll(":", "-")}.json`,
      JSON.stringify(data, null, 2),
      "application/json",
    );
  };

  const chooseRestore = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const raw = await file.text();
    confirmAction("ローカルバックアップを復元", "現在の端末内業務データを、選択したJSONの内容で置き換えます。パスワードとログイン状態は変更されません。", () => {
      onRestore(raw);
    });
  };

  return (
    <div className="screen admin-screen">
      <section className="admin-status-grid">
        <article className={isDev ? "admin-status admin-status--dev" : "admin-status admin-status--live"}>
          <p className="eyebrow">現在の領域</p><h2>{isDev ? "開発者モード" : "本番モード"}</h2><strong>運用回 {workspace.sequence}</strong><p>{isDev ? "終了時にこのテスト業務データを削除します。" : "開催日未設定のため、本番販売は停止条件です。"}</p>
        </article>
        <article className={`admin-status ${data.system.maintenance ? "admin-status--stopped" : "admin-status--open"}`}>
          <p className="eyebrow">営業状態</p><h2>{data.system.maintenance ? "営業停止中" : "受付可能"}</h2><p>モード世代 {data.system.modeEpoch}</p><button type="button" className={data.system.maintenance ? "primary-button" : "danger-button"} onClick={toggleMaintenance}>{data.system.maintenance ? "営業を再開" : "営業を停止"}</button>
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
          <button type="button" className="danger-card" onClick={resetLive} disabled={isDev || !data.system.maintenance}><strong>本番運用回をリセット</strong><span>営業停止・開催終了確認が必要</span></button>
        </div>
      </section>

      <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">コード上の唯一の業務設定</p><h2>有効な設定</h2></div><span className={configErrors.length === 0 ? "status-pill status-pill--done" : "status-pill status-pill--pending"}>{configErrors.length === 0 ? "設定値正常" : `${configErrors.length}件の異常`}</span></div>
        {configErrors.map((error) => <div className="alert alert--danger" key={error}>{error}</div>)}
        <div className="config-grid">
          <div><span>表示番号</span><strong>{FASTPASS_CONFIG.TICKET_PREFIX}001～{FASTPASS_CONFIG.TICKET_PREFIX}{String(FASTPASS_CONFIG.MAX_TICKET_NUMBER).padStart(3, "0")}</strong></div>
          <div><span>単価</span><strong>{FASTPASS_CONFIG.UNIT_PRICE_YEN}円</strong></div>
          <div><span>日別上限</span><strong>各日 {FASTPASS_CONFIG.DAILY_TICKET_LIMITS[1]}枚（仮値）</strong></div>
          <div><span>開催日</span><strong>3日とも未設定</strong></div>
          <div><span>仮確保</span><strong>{FASTPASS_CONFIG.CHECKOUT_HOLD_SECONDS}秒</strong></div>
          <div><span>最終保存</span><strong>{formatDateTime(data.savedAtMs)}</strong></div>
        </div>
      </section>

      <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">このブラウザーだけの識別</p><h2>ローカル端末</h2></div></div>
        <div className="inline-form"><label className="text-field"><span>端末名</span><input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={30} /></label><button type="button" className="secondary-button" onClick={updateDeviceName} disabled={deviceName.trim() === data.system.device.name}>端末名を保存</button></div>
      </section>

      <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">認証情報を含めません</p><h2>データ出力・ローカルバックアップ</h2></div></div>
        {isDev ? <div className="alert alert--warning">開発者モード中は正式な業務出力を無効にしています。全体バックアップはローカル復旧専用です。</div> : (
          <div className="export-grid">
            <button type="button" onClick={() => exportFile("json")}>本番JSON</button>
            <button type="button" onClick={() => exportFile("tickets")}>チケットCSV</button>
            <button type="button" onClick={() => exportFile("sales")}>販売CSV</button>
            <button type="button" onClick={() => exportFile("refunds")}>払戻CSV</button>
            <button type="button" onClick={() => exportFile("audit")}>操作履歴CSV</button>
          </div>
        )}
        <div className="backup-actions">
          <button type="button" className="secondary-button" onClick={backupAll}>端末内データをバックアップ</button>
          <button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}>バックアップから復元</button>
          <input ref={fileInput} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => void chooseRestore(event)} />
        </div>
        <p className="field-note">バックアップはD1移行用ではありません。localStorageの確認データはD1へ読み込みません。</p>
      </section>
    </div>
  );
}
