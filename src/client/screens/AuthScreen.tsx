import { useState, type FormEvent } from "react";
import {
  beginLocalSession,
  configureLocalPassword,
  hasLocalPassword,
  validateNewPassword,
  verifyLocalPassword,
} from "../../infrastructure/localAuth";

type AuthScreenProps = {
  onAuthenticated: () => void;
};

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [setup] = useState(() => !hasLocalPassword());
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (setup) {
        const errors = validateNewPassword(password);
        if (errors.length > 0) throw new Error(errors.join(" "));
        if (password !== confirmation) throw new Error("確認用パスワードが一致しません。");
        await configureLocalPassword(password);
      } else if (!(await verifyLocalPassword(password))) {
        throw new Error("パスワードが正しくありません。");
      }
      setPassword("");
      setConfirmation("");
      beginLocalSession();
      onAuthenticated();
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
        <div className="local-warning">
          <strong>ローカル確認版</strong>
          <span>この端末内だけに保存されます。別のMac・iPadとは同期されません。</span>
        </div>
      </section>
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">{setup ? "初回設定" : "ログイン"}</p>
        <h2 id="auth-title">{setup ? "ローカル専用パスワードを設定" : "管理画面を開く"}</h2>
        <p>{setup ? "10文字以上で、大文字・小文字・数字をそれぞれ含めてください。平文は保存しません。" : "この最初のログイン画面では、端末の標準キーボードを使用できます。"}</p>
        <form onSubmit={(event) => void submit(event)}>
          <label className="text-field">
            <span>パスワード</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete={setup ? "new-password" : "current-password"}
              spellCheck={false}
              disabled={busy}
            />
          </label>
          {setup && (
            <label className="text-field">
              <span>パスワードをもう一度</span>
              <input
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          )}
          {error && <div className="alert alert--danger" role="alert">{error}</div>}
          <button type="submit" className="primary-button auth-submit" disabled={busy || password.length === 0 || (setup && confirmation.length === 0)}>
            {busy ? "確認中…" : setup ? "設定して開始" : "ログイン"}
          </button>
        </form>
        <p className="security-note">これは操作確認用のクライアント認証です。D1接続後の本番認証とは異なり、開発者ツールからの改変を防ぐものではありません。</p>
      </section>
    </main>
  );
}
