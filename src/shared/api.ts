import type { DayNumber } from "../config/fastpass.config";
import type { FastpassData } from "../domain/types";

export type MutationAction =
  | "CREATE_CHECKOUT"
  | "CANCEL_CHECKOUT"
  | "FINALIZE_SALE"
  | "CONFIRM_HANDOVER"
  | "HANDOVER_AND_CHECKIN"
  | "CHECKIN"
  | "REVERSE_CHECKIN"
  | "REFUND"
  | "SET_MAINTENANCE"
  | "ENABLE_DEVELOPER_MODE"
  | "SET_DEVELOPER_DAY"
  | "DISABLE_DEVELOPER_MODE"
  | "RESET_LIVE_WORKSPACE"
  | "RENAME_DEVICE";

export type MutationPayload = {
  quantity?: number;
  checkoutId?: string;
  tenderedYen?: number;
  kind?: "SALE" | "REFUND";
  sourceId?: string;
  saleId?: string;
  serialNumbers?: number[];
  serialNumber?: number;
  expectedUseEventId?: string;
  reason?: string;
  maintenance?: boolean;
  dayNumber?: DayNumber;
  name?: string;
};

export type MutationRequest = {
  requestId: string;
  modeEpoch: number;
  action: MutationAction;
  payload: MutationPayload;
};

export type StateResponse = {
  data: FastpassData;
  serverNowMs: number;
};

export type MutationResponse<T = unknown> = StateResponse & {
  result: T;
  requestId: string;
};

export type AuthStatusResponse = {
  authenticated: boolean;
  initialized: boolean;
  serverNowMs: number;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: string[];
    requestId?: string;
  };
};
