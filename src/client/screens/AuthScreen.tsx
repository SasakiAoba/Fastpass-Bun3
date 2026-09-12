import { useState, type FormEvent } from "react";

type AuthScreenProps = {
  initialized: boolean;
  onLogin: (password: string) => Promise<void>;
};

export function AuthScreen({ initialized, onLogin }: AuthScreenProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(password);
      setPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "認証に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-brand">
        <div className="brand-mark" aria-hidden="true">FP</div>
        <p className="eyebrow">文化祭カジノ企画</p>
        <h1>ファストパス管理</h1>
        <p className="auth-lead">木製チケットの販売から入場、払い戻し、会計までを一つの画面で管理します。</p>
      </section>
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">ログイン</p>
        <h2 id="auth-title">管理画面を開く</h2>
        <p>{initialized ? "共有パスワードを入力してください。ログイン後の通常操作では再入力しません。" : "認証設定が未完了です。管理者がD1の認証情報を設定するまでログインできません。"}</p>
        <form onSubmit={(event) => void submit(event)}>
          <label className="text-field">
            <span>パスワード</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="current-password"
              spellCheck={false}
              disabled={busy}
            />
          </label>
          {error && <div className="alert alert--danger" role="alert">{error}</div>}
          <button type="submit" className="primary-button auth-submit" disabled={!initialized || busy || password.length === 0}>
            {busy ? "確認中…" : "ログイン"}
          </button>
        </form>
        <p className="security-note">認証はサーバーで確認し、安全なCookieで保持します。共有端末を離れるときはログアウトしてください。</p>
      </section>
    </main>
  );
}
