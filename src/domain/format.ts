import { FASTPASS_CONFIG } from "../config/fastpass.config";

export function formatTicketCode(number: number): string {
  if (!Number.isSafeInteger(number) || number < FASTPASS_CONFIG.MIN_TICKET_NUMBER) {
    throw new Error("INVALID_TICKET_NUMBER");
  }
  return `${FASTPASS_CONFIG.TICKET_PREFIX}${String(number).padStart(
    FASTPASS_CONFIG.NUMBER_MIN_DIGITS,
    "0",
  )}`;
}

export function formatGroupNumber(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("INVALID_GROUP_NUMBER");
  }
  return `G-${String(number).padStart(4, "0")}`;
}

export function formatYen(value: number): string {
  return `${new Intl.NumberFormat("ja-JP").format(value)}円`;
}

export function formatDateTime(value: number | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: FASTPASS_CONFIG.TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

export function getJstDateString(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FASTPASS_CONFIG.TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nowMs);
}

export function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
