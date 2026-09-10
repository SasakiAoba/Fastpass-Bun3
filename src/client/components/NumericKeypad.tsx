type NumericKeypadProps = {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled?: boolean;
  confirmDisabled?: boolean;
  maxDigits?: number;
  quickExactValue?: number;
};

const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3"];

export function NumericKeypad({
  value,
  onChange,
  onConfirm,
  confirmLabel,
  disabled = false,
  confirmDisabled = false,
  maxDigits = 8,
  quickExactValue,
}: NumericKeypadProps) {
  const append = (digit: string) => {
    if (disabled || value.length >= maxDigits) return;
    const next = value === "0" ? digit : `${value}${digit}`;
    onChange(next);
  };

  return (
    <div className="numeric-keypad" aria-label="数字入力キーパッド">
      <div className="keypad-grid">
        {KEYS.map((key) => (
          <button key={key} type="button" className="keypad-key" onClick={() => append(key)} disabled={disabled}>
            {key}
          </button>
        ))}
        <button type="button" className="keypad-key keypad-key--utility" onClick={() => onChange("")} disabled={disabled} aria-label="入力をすべて消去">
          C
        </button>
        <button type="button" className="keypad-key" onClick={() => append("0")} disabled={disabled}>
          0
        </button>
        <button type="button" className="keypad-key keypad-key--utility" onClick={() => onChange(value.slice(0, -1))} disabled={disabled || value.length === 0} aria-label="末尾を1文字削除">
          ⌫
        </button>
      </div>
      {quickExactValue !== undefined && (
        <button type="button" className="secondary-button keypad-exact" onClick={() => onChange(String(quickExactValue))} disabled={disabled}>
          ちょうど {quickExactValue.toLocaleString("ja-JP")}円
        </button>
      )}
      <button type="button" className="primary-button keypad-confirm" onClick={onConfirm} disabled={disabled || confirmDisabled || value.length === 0}>
        {confirmLabel}
      </button>
    </div>
  );
}
