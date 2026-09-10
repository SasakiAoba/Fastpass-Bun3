import { useState } from "react";

type PasswordKeypadProps = {
  title: string;
  description: string;
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => Promise<void>;
  onCancel: () => void;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "1234567890".split("");

export function PasswordKeypad({
  title,
  description,
  busy,
  error,
  onSubmit,
  onCancel,
}: PasswordKeypadProps) {
  const [value, setValue] = useState("");
  const [upper, setUpper] = useState(true);

  const submit = async () => {
    await onSubmit(value);
    setValue("");
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card password-modal" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
        <div className="modal-heading">
          <div>
            <p className="eyebrow">操作時の再認証</p>
            <h2 id="reauth-title">{title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="再認証を閉じる" disabled={busy}>×</button>
        </div>
        <p>{description}</p>
        <div className="password-display" aria-label={`パスワード ${value.length}文字`}>
          {value.length > 0 ? "●".repeat(value.length) : "パスワードを入力"}
        </div>
        {error && <div className="alert alert--danger" role="alert">{error}</div>}
        <div className="alpha-keypad" aria-label="英数字キーボード">
          {LETTERS.map((letter) => {
            const label = upper ? letter : letter.toLowerCase();
            return (
              <button key={letter} type="button" onClick={() => setValue((current) => `${current}${label}`)} disabled={busy}>
                {label}
              </button>
            );
          })}
          {DIGITS.map((digit) => (
            <button key={digit} type="button" onClick={() => setValue((current) => `${current}${digit}`)} disabled={busy}>
              {digit}
            </button>
          ))}
        </div>
        <div className="password-actions">
          <button type="button" className="secondary-button" onClick={() => setUpper((current) => !current)} disabled={busy}>
            {upper ? "小文字へ" : "大文字へ"}
          </button>
          <button type="button" className="secondary-button" onClick={() => setValue("")} disabled={busy || value.length === 0}>全消去</button>
          <button type="button" className="secondary-button" onClick={() => setValue((current) => current.slice(0, -1))} disabled={busy || value.length === 0}>1文字削除</button>
          <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy || value.length === 0}>
            {busy ? "確認中…" : "パスワードを確認"}
          </button>
        </div>
        <p className="field-note">この画面では端末のソフトウェアキーボードを使用しません。</p>
      </section>
    </div>
  );
}
