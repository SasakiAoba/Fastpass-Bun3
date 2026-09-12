import { useCallback, useEffect, useRef, useState } from "react";
import { AccountingScreen } from "./client/screens/AccountingScreen";
import { AdminScreen } from "./client/screens/AdminScreen";
import { AdmissionScreen } from "./client/screens/AdmissionScreen";
import { AuthScreen } from "./client/screens/AuthScreen";
import { HomeScreen } from "./client/screens/HomeScreen";
import { MaintenanceScreen } from "./client/screens/MaintenanceScreen";
import { RecordsScreen } from "./client/screens/RecordsScreen";
import { SalesScreen } from "./client/screens/SalesScreen";
import { ConfirmationDialog } from "./client/components/ConfirmationDialog";
import type { Mutate, RequestConfirmation, ScreenName } from "./client/uiTypes";
import { getActiveWorkspace, getSummary } from "./domain/engine";
import type { FastpassData } from "./domain/types";
import { ApiClient, ApiClientError, rememberDeviceName } from "./infrastructure/apiClient";
import { loadStartupState } from "./infrastructure/startup";

type Notice = {
  kind: "success" | "error" | "warning";
  message: string;
  details?: string[];
};

type ConfirmationState = {
  title: string;
  description: string;
  action: () => void | Promise<void>;
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
  const client = useRef(new ApiClient());
  const [data, setData] = useState<FastpassData | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [initialized, setInitialized] = useState(true);
  const [booting, setBooting] = useState(true);
  const [dataLoadError, setDataLoadError] = useState<string | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [mutating, setMutating] = useState(false);
  const mutatingRef = useRef(false);
  const [screen, setScreen] = useState<ScreenName>("home");
  const [nowMs, setNowMs] = useState(Date.now());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now() + serverOffsetMs);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [serverOffsetMs]);

  const applyState = useCallback((next: { data: FastpassData; serverNowMs: number }) => {
    setData(next.data);
    setServerOffsetMs(next.serverNowMs - Date.now());
    setNowMs(next.serverNowMs);
  }, []);

  const showError = useCallback((error: unknown) => {
    const apiError = error instanceof ApiClientError ? error : null;
    if (apiError?.status === 401) {
      setAuthenticated(false);
      setData(null);
    }
    setNotice({
      kind: "error",
      message: apiError ? `${apiError.code}: ${apiError.message}` : error instanceof Error ? error.message : "操作を完了できませんでした。",
      details: apiError?.details,
    });
  }, []);

  const loadAuthenticatedState = useCallback(async () => {
    const startup = await loadStartupState(client.current);
    applyState(startup.state);
    setDataLoadError(null);
    if (startup.autoStartError) showError(startup.autoStartError);
    return startup.autoStartError;
  }, [applyState, showError]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const status = await client.current.status();
        if (!active) return;
        setInitialized(status.initialized);
        setAuthenticated(status.authenticated);
        setServerOffsetMs(status.serverNowMs - Date.now());
        if (status.authenticated) {
          try {
            await loadAuthenticatedState();
          } catch (error) {
            if (error instanceof ApiClientError && error.status === 401) {
              showError(error);
            } else {
              setDataLoadError(error instanceof Error ? error.message : "データを読み込めませんでした。");
            }
          }
        }
      } catch (error) {
        if (active) showError(error);
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => { active = false; };
  }, [loadAuthenticatedState, showError]);

  useEffect(() => {
    if (!authenticated || !data || mutating) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void client.current.state().then(applyState).catch((error) => {
        if (error instanceof ApiClientError && error.status === 401) showError(error);
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [applyState, authenticated, data, mutating, showError]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === "error" ? 8_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const mutate: Mutate = useCallback(
    async <T,>(action: Parameters<ApiClient["mutate"]>[0], payload: Parameters<ApiClient["mutate"]>[1], successMessage?: string) => {
      if (!data || mutatingRef.current) return null;
      mutatingRef.current = true;
      setMutating(true);
      try {
        const response = await client.current.mutate<T>(action, payload, data.system.modeEpoch);
        applyState(response);
        if (action === "RENAME_DEVICE" && typeof payload.name === "string") rememberDeviceName(payload.name);
        if (successMessage) setNotice({ kind: "success", message: successMessage });
        return response.result;
      } catch (error) {
        showError(error);
        return null;
      } finally {
        mutatingRef.current = false;
        setMutating(false);
      }
    },
    [applyState, data, showError],
  );

  const requestConfirmation: RequestConfirmation = useCallback((title, description, action) => {
    setConfirmation({ title, description, action });
  }, []);

  const handleConfirmation = async () => {
    if (!confirmation) return;
    const action = confirmation.action;
    setConfirmation(null);
    await action();
  };

  const login = useCallback(async (password: string) => {
    let status;
    try {
      status = await client.current.login(password);
    } catch (error) {
      throw new Error(error instanceof ApiClientError ? error.message : "ログインできませんでした。");
    }
    setAuthenticated(status.authenticated);
    setInitialized(status.initialized);
    setDataLoadError(null);
    try {
      const autoStartError = await loadAuthenticatedState();
      if (!autoStartError) setNotice({ kind: "success", message: "ログインしました。" });
    } catch (error) {
      setDataLoadError(error instanceof Error ? error.message : "ログイン後のデータを読み込めませんでした。");
    }
  }, [loadAuthenticatedState]);

  const logout = useCallback(async () => {
    try {
      await client.current.logout();
      setAuthenticated(false);
      setData(null);
      setDataLoadError(null);
      setScreen("home");
      setConfirmation(null);
    } catch (error) {
      showError(error);
    }
  }, [showError]);

  const retryDataLoad = useCallback(async () => {
    setDataLoadError(null);
    try {
      await loadAuthenticatedState();
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) showError(error);
      else setDataLoadError(error instanceof Error ? error.message : "データを読み込めませんでした。");
    }
  }, [loadAuthenticatedState, showError]);

  if (booting) {
    return <main className="auth-shell"><section className="auth-card"><h1>接続を確認しています…</h1></section></main>;
  }

  if (!authenticated) {
    return (
      <>
        {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
        <AuthScreen initialized={initialized} onLogin={login} />
      </>
    );
  }

  if (!data) {
    return (
      <main className="auth-shell">
        {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
        <section className="auth-card" aria-live="polite">
          <p className="eyebrow">ログイン済み</p>
          <h1>運用データを読み込めません</h1>
          <p>{dataLoadError || "サーバーのデータ取得に失敗しました。"}</p>
          <button type="button" className="primary-button" onClick={() => void retryDataLoad()}>もう一度読み込む</button>
          <button type="button" className="secondary-button" onClick={() => void logout()}>ログアウト</button>
        </section>
      </main>
    );
  }

  const workspace = getActiveWorkspace(data);
  const summary = getSummary(structuredClone(data), nowMs);
  const modeIsDev = data.system.mode === "DEVELOPMENT";

  return (
    <div className={`app-shell ${modeIsDev ? "app-shell--dev" : ""}`}>
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
        <div className="header-actions">
          <button type="button" className="logout-button" onClick={() => void logout()}>ログアウト</button>
        </div>
      </header>
      {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
      <main className="app-main">
        {screen === "home" && <HomeScreen summary={summary} workspace={workspace} onNavigate={setScreen} />}
        {screen === "sales" && (data.system.maintenance
          ? <MaintenanceScreen />
          : <SalesScreen data={data} summary={summary} mutate={mutate} requestConfirmation={requestConfirmation} />)}
        {screen === "admission" && (data.system.maintenance
          ? <MaintenanceScreen />
          : <AdmissionScreen data={data} mutate={mutate} requestConfirmation={requestConfirmation} />)}
        {screen === "records" && <RecordsScreen data={data} mutate={mutate} />}
        {screen === "accounting" && <AccountingScreen data={data} summary={summary} />}
        {screen === "admin" && <AdminScreen data={data} mutate={mutate} requestConfirmation={requestConfirmation} />}
      </main>
      {confirmation && (
        <ConfirmationDialog
          title={confirmation.title}
          description={confirmation.description}
          onConfirm={() => void handleConfirmation()}
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
