import { FastpassError } from "../domain/errors";
import { createInitialData } from "../domain/initialState";
import type { FastpassData } from "../domain/types";

export const BUSINESS_STORAGE_KEY = "bun3-fastpass:business:v1";

export type LoadResult = {
  data: FastpassData;
  recovered: boolean;
  warning: string | null;
};

function isFastpassData(value: unknown): value is FastpassData {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<FastpassData>;
  return (
    data.schemaVersion === 1 &&
    typeof data.savedAtMs === "number" &&
    !!data.system &&
    Array.isArray(data.workspaces) &&
    Array.isArray(data.sales) &&
    Array.isArray(data.tickets) &&
    Array.isArray(data.operations)
  );
}

export class LocalStorageRepository {
  load(): LoadResult {
    const raw = localStorage.getItem(BUSINESS_STORAGE_KEY);
    if (!raw) {
      const data = createInitialData();
      this.save(data);
      return { data, recovered: false, warning: null };
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isFastpassData(parsed)) {
        throw new Error("保存形式が現在のバージョンと一致しません。");
      }
      return { data: parsed, recovered: false, warning: null };
    } catch (error) {
      const backupKey = `${BUSINESS_STORAGE_KEY}:corrupt:${Date.now()}`;
      try {
        localStorage.setItem(backupKey, raw);
      } catch {
        // 元データは上書きしない。バックアップ不能でも復旧用の警告を返す。
      }
      const data = createInitialData();
      return {
        data,
        recovered: true,
        warning:
          error instanceof Error
            ? `保存データを読み込めませんでした。元データを保護し、新しい一時状態で起動しました: ${error.message}`
            : "保存データを読み込めませんでした。元データを保護し、新しい一時状態で起動しました。",
      };
    }
  }

  save(data: FastpassData): FastpassData {
    const next = structuredClone(data);
    next.savedAtMs = Date.now();
    try {
      localStorage.setItem(BUSINESS_STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      throw new FastpassError(
        "STORAGE_UNAVAILABLE",
        "端末内への保存に失敗しました。操作結果を確定扱いにせず、空き容量を確認してください。",
        [error instanceof Error ? error.message : "不明な保存エラー"],
      );
    }
    return next;
  }

  replaceFromJson(raw: string): FastpassData {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FastpassError("INVALID_INPUT", "JSONとして読み込めませんでした。");
    }
    if (!isFastpassData(parsed)) {
      throw new FastpassError("INVALID_INPUT", "対応していないバックアップ形式です。");
    }
    return this.save(parsed);
  }

  clearBusinessData(): FastpassData {
    const data = createInitialData();
    return this.save(data);
  }

  rawBackup(): string | null {
    return localStorage.getItem(BUSINESS_STORAGE_KEY);
  }
}
