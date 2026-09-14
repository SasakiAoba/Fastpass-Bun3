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
import { ApiClient, ApiClientError, type PendingOperation, rememberDeviceName } from "./infrastructure/apiClient";
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
  modeEpoch: number;
};

const NAVIGATION: Array<{ id: ScreenName; label: string; short: string }> = [
  { id: "home", label: "ホーム", short: "H" },
  { id: "sales", label: "販売", short: "¥" },
  { id: "admission", label: "入場受付", short: "✓" },
  { id: "records", label: "記録", short: "▤" },
  { id: "accounting", label: "会計", short: "Σ" },
  { id: "admin", label: "管理", short: "⚙" },
];

const MUTATION_LABELS: Record<PendingOperation["action"], string> = {
  SELL_TICKETS: "販売・発番",
  CREATE_CHECKOUT: "販売の一時確保",
  CANCEL_CHECKOUT: "一時確保の取消",
  FINALIZE_SALE: "販売確定",
  CONFIRM_HANDOVER: "受渡し確認",
  HANDOVER_AND_CHECKIN: "販売直後の受渡し・入場",
  CHECKIN: "入場確定",
  REVERSE_CHECKIN: "入場取消",
  REFUND: "払い戻し",
  SET_MAINTENANCE: "営業状態の変更",
  ENABLE_DEVELOPER_MODE: "開発者モード開始",
  SET_DEVELOPER_DAY: "テスト日の変更",
  DISABLE_DEVELOPER_MODE: "開発者モード終了・テストデータ削除",
  RESET_LIVE_WORKSPACE: "本番運用回のリセット",
  RENAME_DEVICE: "端末名の変更",
};

export default function App() {
  const client = useRef(new ApiClient());
  const stateRequestSequenceRef = useRef(0);
  const [data, setData] = useState<FastpassData | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [initialized, setInitialized] = useState(true);
  const [booting, setBooting] = useState(true);
  const [dataLoadError, setDataLoadError] = useState<string | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [mutating, setMutating] = useState(false);
  const mutatingRef = useRef(false);
  const recoveringOperationRef = useRef(false);
  const [recoveringOperation, setRecoveringOperation] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(() => { try { return client.current.pendingOperation(); } catch { return null; } });
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
      stateRequestSequenceRef.current += 1;
      setAuthenticated(false);
      setData(null);
    }
    setNotice({
      kind: "error",
      message: apiError ? `${apiError.code}: ${apiError.message}` : error instanceof Error ? error.message : "操作を完了できませんでした。",
      details: apiError?.details,
    });
  }, []);

  useEffect(() => {
    const updatePending = (event: StorageEvent) => {
      if (event.key && !event.key.startsWith("bun3-fastpass:pending-operation:v1")) return;
      try { setPendingOperation(client.current.pendingOperation()); } catch (error) { showError(error); }
    };
    window.addEventListener("storage", updatePending);
    return () => window.removeEventListener("storage", updatePending);
  }, [showError]);

  const loadAuthenticatedState = useCallback(async () => {
    const requestSequence = ++stateRequestSequenceRef.current;
    const startup = await loadStartupState(client.current);
    if (requestSequence === stateRequestSequenceRef.current) applyState(startup.state);
    setDataLoadError(null);
    if (startup.autoStartError) showError(startup.autoStartError);
    setPendingOperation(client.current.pendingOperation());
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
    if (!authenticated || !data || mutating || pendingOperation || recoveringOperation) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden" || mutatingRef.current || recoveringOperationRef.current) return;
      const requestSequence = ++stateRequestSequenceRef.current;
      void client.current.state().then((next) => {
        if (requestSequence === stateRequestSequenceRef.current && !mutatingRef.current) applyState(next);
      }).catch((error) => {
        if (requestSequence === stateRequestSequenceRef.current && error instanceof ApiClientError && error.status === 401) showError(error);
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [applyState, authenticated, data, mutating, pendingOperation, recoveringOperation, showError]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.kind === "error" ? 8_000 : 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!confirmation || !data || confirmation.modeEpoch === data.system.modeEpoch) return;
    setConfirmation(null);
    setNotice({
      kind: "warning",
      message: "別の端末で営業状態またはモードが変わったため、開いていた確認画面を閉じました。最新状態を確認してから操作してください。",
    });
  }, [confirmation, data]);

  const mutate: Mutate = useCallback(
    async <T,>(action: Parameters<ApiClient["mutate"]>[0], payload: Parameters<ApiClient["mutate"]>[1], successMessage?: string) => {
      if (!data || mutatingRef.current || recoveringOperationRef.current) return null;
      stateRequestSequenceRef.current += 1;
      mutatingRef.current = true;
      setMutating(true);
      try {
        const response = await client.current.mutate<T>(action, payload, data.system.modeEpoch);
        applyState(response);
        if (action === "RENAME_DEVICE" && typeof payload.name === "string") rememberDeviceName(payload.name);
        if (successMessage) setNotice({ kind: "success", message: successMessage });
        return response.result;
      } catch (error) {
        if (error instanceof ApiClientError && ["STATE_CONFLICT", "MODE_CHANGED", "OPERATION_PURGED"].includes(error.code)) {
          try { applyState(await client.current.state()); } catch { /* 元の競合通知を保持 */ }
        }
        showError(error);
        return null;
      } finally {
        try { setPendingOperation(client.current.pendingOperation()); } catch (error) { showError(error); }
        mutatingRef.current = false;
        setMutating(false);
      }
    },
    [applyState, data, showError],
  );

  const requestConfirmation: RequestConfirmation = useCallback((title, description, action) => {
    if (!data || mutatingRef.current || recoveringOperationRef.current) return;
    setConfirmation({ title, description, action, modeEpoch: data.system.modeEpoch });
  }, [data]);

  const handleConfirmation = async () => {
    if (!confirmation || confirmation.modeEpoch !== data?.system.modeEpoch || mutatingRef.current || recoveringOperationRef.current) {
      setConfirmation(null);
      return;
    }
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
    setInitialized(status.initialized);
    setDataLoadError(null);
    try {
      const autoStartError = await loadAuthenticatedState();
      if (!autoStartError) setNotice({ kind: "success", message: "ログインしました。" });
    } catch (error) {
      setDataLoadError(error instanceof Error ? error.message : "ログイン後のデータを読み込めませんでした。");
    } finally {
      setAuthenticated(status.authenticated);
    }
  }, [loadAuthenticatedState]);

  const logout = useCallback(async () => {
    stateRequestSequenceRef.current += 1;
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

  const recoverOperation = useCallback(async () => {
    if (mutatingRef.current || recoveringOperationRef.current) return;
    recoveringOperationRef.current = true;
    setRecoveringOperation(true);
    stateRequestSequenceRef.current += 1;
    try {
      const response = await client.current.recoverPendingOperation();
      applyState(response);
      setConfirmation(null);
      setScreen("records");
      setNotice({ kind: "success", message: "前回の操作は記録済みです。再実行せず、記録画面で券番号と受渡し状況を確認してください。" });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "OPERATION_PURGED") {
        try { applyState(await client.current.state()); setScreen("records"); } catch { /* 結果の通知を保持 */ }
      }
      showError(error);
    } finally {
      try { setPendingOperation(client.current.pendingOperation()); } catch (error) { showError(error); }
      recoveringOperationRef.current = false;
      setRecoveringOperation(false);
    }
  }, [applyState, showError]);

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
      {(modeIsDev || data.system.environment === "preview") && (
        <div className="dev-mode-banner">
          <strong>{data.system.environment === "preview" ? "Preview — テスト専用" : "開発者モード — テストデータ"}</strong>
          <span>{modeIsDev ? "日別・総発行上限なし／実物の券と現金は扱わない／終了時に削除" : "テスト停止中／管理画面から開発者モードを開始してください"}</span>
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
      {pendingOperation && <section className="operation-recovery" role="region" aria-label="前回の操作結果を確認">
        <h2>前回の操作結果を確認してください</h2>
        <p>{MUTATION_LABELS[pendingOperation.action]}の{pendingOperation.commitConfirmed ? "処理は記録済みですが、最新状態の取得が完了していません。" : "結果が未確認です。"}重複処理を防ぐため、新しい確定操作を停止しています。</p>
        <p>操作ID：{pendingOperation.requestId}</p>
        <button type="button" className="primary-button" disabled={recoveringOperation} onClick={() => void recoverOperation()}>{recoveringOperation ? "確認しています…" : "操作結果を読み取りで確認"}</button>
      </section>}
      <main className="app-main">
        <fieldset className="operation-controls" disabled={mutating || !!pendingOperation || recoveringOperation}>
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
        </fieldset>
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
