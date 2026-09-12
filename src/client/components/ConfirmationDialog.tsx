import { useEffect } from "react";

type ConfirmationDialogProps = {
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmationDialog({
  title,
  description,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop">
      <section
        className="modal-card confirmation-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-description"
      >
        <p className="eyebrow">操作内容を確認</p>
        <h2 id="confirmation-title">{title}</h2>
        <p id="confirmation-description">{description}</p>
        <div className="confirmation-actions">
          <button type="button" className="secondary-button" onClick={onCancel} autoFocus>
            キャンセル
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            実行する
          </button>
        </div>
      </section>
    </div>
  );
}
