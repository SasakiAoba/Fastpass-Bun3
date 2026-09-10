export type ErrorCode =
  | "INVALID_INPUT"
  | "EVENT_DATE_NOT_CONFIGURED"
  | "OUTSIDE_SALES_DATE"
  | "DAILY_LIMIT_REACHED"
  | "NUMBER_LIMIT_REACHED"
  | "INSUFFICIENT_CAPACITY"
  | "HOLD_EXPIRED"
  | "TICKET_NOT_FOUND"
  | "TICKET_STATE_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "MAINTENANCE"
  | "MODE_CHANGED"
  | "PENDING_HANDOVER_EXISTS"
  | "INVALID_SYSTEM_STATE"
  | "STORAGE_UNAVAILABLE";

export class FastpassError extends Error {
  readonly code: ErrorCode;
  readonly details?: string[];

  constructor(code: ErrorCode, message: string, details?: string[]) {
    super(message);
    this.name = "FastpassError";
    this.code = code;
    this.details = details;
  }
}

export function isFastpassError(value: unknown): value is FastpassError {
  return value instanceof FastpassError;
}
