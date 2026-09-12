import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountingScreen } from "./client/screens/AccountingScreen";
import { AdminScreen } from "./client/screens/AdminScreen";
import { AdmissionScreen } from "./client/screens/AdmissionScreen";
import { AuthScreen } from "./client/screens/AuthScreen";
import { HomeScreen } from "./client/screens/HomeScreen";
import { RecordsScreen } from "./client/screens/RecordsScreen";
import { SalesScreen } from "./client/screens/SalesScreen";
import { ConfirmationDialog } from "./client/components/ConfirmationDialog";
import type { Commit, RequestConfirmation, ScreenName } from "./client/uiTypes";
import { getActiveWorkspace, getSummary } from "./domain/engine";
import { isFastpassError } from "./domain/errors";
import { formatDateTime } from "./domain/format";
import type { FastpassData } from "./domain/types";
import {
  endLocalSession,
  isLocalSessionValid,
} from "./infrastructure/localAuth";
import { LocalStorageRepository } from "./infrastructure/localStorageRepository";

type Notice = {
  kind: "success" | "error" | "warning";
  message: string;
  details?: string[];
};

type ConfirmationState = {
  title: string;
  description: string;
  action: () => void;
};

const NAVIGATION: Array<{ id: ScreenName; label: string; short: string }> = [
  { id: "home", label: "ホーム", short: "H" },
  { id: "sales", label: "販売", short: "¥" },
  { id: "admission", label: "入場受付", short: "✓" },
  { id: "records", label: "記録", short: "▤" },
  { id: "accounting", label: "会計", short: "Σ" },
  { id: "admin", label: "管理", short: "⚙" },
];

export default function App() {
  const repository = useRef(new LocalStorageRepository());
  const initialLoad = useMemo(() => repository.current.load(), []);
  const [data, setData] = useState<FastpassData>(initialLoad.data);
  const [authenticated, setAuthenticated] = useState(() => isLocalSessionValid());
  const [screen, setScreen] = useState<ScreenName>("home");
  const [nowMs, setNowMs] = useState(Date.now());
  const [notice, setNotice] = useState<Notice | null>(
    initialLoad.warning ? { kind: "warning", message: initialLoad.warning } : null,
  );
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === "error" ? 8_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const commit: Commit = useCallback(
    (recipe, successMessage) => {
      try {
        const draft = structuredClone(data);
        const result = recipe(draft);
        const saved = repository.current.save(draft);
        setData(saved);
        if (successMessage) setNotice({ kind: "success", message: successMessage });
        return result;
      } catch (error) {
        const message = isFastpassError(error)
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : "操作を完了できませんでした。";
        setNotice({
          kind: "error",
          message,
          details: isFastpassError(error) ? error.details : undefined,
        });
        return null;
      }
    },
    [data],
  );

  const requestConfirmation: RequestConfirmation = useCallback((title, description, action) => {
    setConfirmation({ title, description, action });
  }, []);

  const handleConfirmation = () => {
    if (!confirmation) return;
    const action = confirmation.action;
    setConfirmation(null);
    action();
  };

  const logout = useCallback(() => {
    endLocalSession();
    setAuthenticated(false);
    setScreen("home");
    setConfirmation(null);
  }, []);

  const restore = useCallback((raw: string) => {
    try {
      const restored = repository.current.replaceFromJson(raw);
      setData(restored);
      setNotice({ kind: "success", message: "ローカルバックアップを復元しました。" });
      return true;
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "復元できませんでした。" });
      return false;
    }
  }, []);

  if (!authenticated) {
    return (
      <>
        {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
        <AuthScreen onAuthenticated={() => { setAuthenticated(true); setNotice({ kind: "success", message: "ログインしました。" }); }} />
      </>
    );
  }

  const workspace = getActiveWorkspace(data);
  const summary = getSummary(structuredClone(data), nowMs);
  const modeIsDev = data.system.mode === "DEVELOPMENT";

  return (
    <div className={`app-shell ${modeIsDev ? "app-shell--dev" : ""}`}>
      <div className="local-edition-banner">
        <strong>ローカル確認版</strong>
        <span>このブラウザー内だけに保存・端末間同期なし・本番運用不可</span>
      </div>
      {modeIsDev && (
        <div className="dev-mode-banner">
          <strong>開発者モード — テストデータ</strong>
          <span>日別・総発行上限なし／実物の券と現金は扱わない／終了時に削除</span>
        </div>
      )}
      {data.system.maintenance && <div className="maintenance-banner"><strong>営業停止中</strong><span>新規業務更新は管理画面から再開するまで停止します。</span></div>}
      <header className="app-header">
        <div className="app-identity">
          <div className="brand-mark brand-mark--small" aria-hidden="true">FP</div>
          <div><span>文化祭カジノ企画</span><strong>ファストパス管理</strong></div>
        </div>
        <nav className="main-nav" aria-label="メインメニュー">
          {NAVIGATION.map((item) => (
            <button type="button" key={item.id} className={screen === item.id ? "active" : ""} aria-current={screen === item.id ? "page" : undefined} onClick={() => setScreen(item.id)}>
              <span aria-hidden="true">{item.short}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="header-status">
          <div><span>{modeIsDev ? "開発" : "本番"}・運用回{workspace.sequence}</span><strong>{data.system.device.name}</strong></div>
          <div><span>日本時間</span><strong>{formatDateTime(nowMs).split(" ").at(-1)}</strong></div>
          <button type="button" className="logout-button" onClick={logout}>ログアウト</button>
        </div>
      </header>
      {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
      <main className="app-main">
        {screen === "home" && <HomeScreen summary={summary} workspace={workspace} onNavigate={setScreen} />}
        {screen === "sales" && <SalesScreen data={data} summary={summary} nowMs={nowMs} commit={commit} />}
        {screen === "admission" && <AdmissionScreen data={data} commit={commit} requestConfirmation={requestConfirmation} />}
        {screen === "records" && <RecordsScreen data={data} commit={commit} />}
        {screen === "accounting" && <AccountingScreen data={data} summary={summary} />}
        {screen === "admin" && <AdminScreen data={data} commit={commit} requestConfirmation={requestConfirmation} onRestore={restore} />}
      </main>
      {confirmation && (
        <ConfirmationDialog
          title={confirmation.title}
          description={confirmation.description}
          onConfirm={handleConfirmation}
          onCancel={() => setConfirmation(null)}
        />
      )}
    </div>
  );
}

function NoticeBanner({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  return (
    <div className={`toast toast--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <div><strong>{notice.kind === "success" ? "完了" : notice.kind === "warning" ? "確認" : "操作できません"}</strong><span>{notice.message}</span>{notice.details?.map((detail) => <small key={detail}>{detail}</small>)}</div>
      <button type="button" onClick={onClose} aria-label="通知を閉じる">×</button>
    </div>
  );
}
