import type { DayNumber, FastpassConfig } from "../config/fastpass.config";

export type SystemMode = "LIVE" | "ENTERING_DEV" | "DEVELOPMENT" | "PURGING_DEV";
export type WorkspaceKind = "LIVE" | "DEV";
export type WorkspaceStatus = "ACTIVE" | "ARCHIVED";
export type CheckoutStatus = "HELD" | "CANCELLED" | "EXPIRED" | "COMPLETED";
export type TicketStatus = "ISSUED" | "USED" | "REFUNDED";
export type TicketEventType = "SALE" | "CHECKIN" | "CHECKIN_REVERSAL" | "REFUND";
export type CashMovementType =
  | "OPENING_FLOAT"
  | "SALE"
  | "REFUND"
  | "TOP_UP"
  | "COLLECTION"
  | "EXPENSE"
  | "REVERSAL";

export type Device = {
  id: string;
  name: string;
  createdAtMs: number;
};

export type SystemState = {
  mode: SystemMode;
  modeEpoch: number;
  maintenance: boolean;
  liveWorkspaceId: string;
  devWorkspaceId: string | null;
  device: Device;
};

export type BusinessDayState = {
  dayNumber: DayNumber;
  eventDate: string | null;
  ticketLimit: number;
  soldCount: number;
};

export type Workspace = {
  id: string;
  kind: WorkspaceKind;
  status: WorkspaceStatus;
  sequence: number;
  startedAtMs: number;
  endedAtMs: number | null;
  configRevision: string;
  configSnapshot: FastpassConfig;
  lastTicketNumber: number;
  lastGroupNumber: number;
  selectedTestDay: DayNumber;
  businessDays: Record<DayNumber, BusinessDayState>;
  expensesConfirmedAtMs: number | null;
};

export type Checkout = {
  id: string;
  workspaceId: string;
  dayNumber: DayNumber;
  quantity: number;
  unitPriceYen: number;
  status: CheckoutStatus;
  createdAtMs: number;
  expiresAtMs: number;
  deviceId: string;
  cashboxId: string;
};

export type Sale = {
  id: string;
  workspaceId: string;
  checkoutId: string;
  groupNumber: number;
  dayNumber: DayNumber;
  quantity: number;
  unitPriceYen: number;
  totalYen: number;
  tenderedYen: number;
  changeYen: number;
  purchasedAtMs: number;
  deviceId: string;
  cashboxId: string;
  ticketIds: string[];
  ticketNumbers: number[];
  handoverConfirmedAtMs: number | null;
};

export type Ticket = {
  id: string;
  workspaceId: string;
  serialNumber: number;
  saleId: string;
  status: TicketStatus;
  usedAtMs: number | null;
  currentUseEventId: string | null;
  refundedAtMs: number | null;
  version: number;
};

export type TicketEvent = {
  id: string;
  workspaceId: string;
  ticketId: string;
  type: TicketEventType;
  fromStatus: TicketStatus | "UNISSUED";
  toStatus: TicketStatus;
  occurredAtMs: number;
  deviceId: string;
  operationId: string;
  reason: string | null;
  reversedEventId: string | null;
};

export type Admission = {
  id: string;
  workspaceId: string;
  ticketIds: string[];
  operationId: string;
  occurredAtMs: number;
  deviceId: string;
};

export type CheckinReversal = {
  id: string;
  workspaceId: string;
  ticketId: string;
  useEventId: string;
  reason: string;
  operationId: string;
  occurredAtMs: number;
  deviceId: string;
};

export type Refund = {
  id: string;
  workspaceId: string;
  ticketIds: string[];
  refundAmountsYen: number[];
  totalYen: number;
  reason: string;
  operationId: string;
  occurredAtMs: number;
  deviceId: string;
  cashboxId: string;
  handoverConfirmedAtMs: number | null;
};

export type Cashbox = {
  id: string;
  workspaceId: string;
  name: string;
};

export type CashLedgerEntry = {
  id: string;
  workspaceId: string;
  cashboxId: string;
  type: CashMovementType;
  amountYen: number;
  occurredAtMs: number;
  dayNumber: DayNumber | null;
  sourceType: string;
  sourceId: string;
  reason: string | null;
  reversedEntryId: string | null;
  deviceId: string;
};

export type Expense = {
  id: string;
  workspaceId: string;
  amountYen: number;
  category: string;
  paymentSource: "CASHBOX" | "OUTSIDE";
  occurredAtMs: number;
  dayNumber: DayNumber;
  reason: string;
  ledgerEntryId: string | null;
  cancelledAtMs: number | null;
  deviceId: string;
};

export type CashCount = {
  id: string;
  workspaceId: string;
  cashboxId: string;
  actualYen: number;
  expectedYen: number;
  differenceYen: number;
  occurredAtMs: number;
  deviceId: string;
};

export type BusinessOperation = {
  id: string;
  workspaceId: string;
  type: string;
  requestHash: string;
  result: unknown;
  committedAtMs: number;
};

export type AuditLog = {
  id: string;
  workspaceId: string | null;
  type: string;
  status: "SUCCESS" | "REJECTED";
  occurredAtMs: number;
  deviceId: string;
  operationId: string | null;
  detail: string;
};

export type FastpassData = {
  schemaVersion: 1;
  savedAtMs: number;
  system: SystemState;
  workspaces: Workspace[];
  checkouts: Checkout[];
  sales: Sale[];
  tickets: Ticket[];
  ticketEvents: TicketEvent[];
  admissions: Admission[];
  checkinReversals: CheckinReversal[];
  refunds: Refund[];
  cashboxes: Cashbox[];
  cashLedger: CashLedgerEntry[];
  expenses: Expense[];
  cashCounts: CashCount[];
  operations: BusinessOperation[];
  auditLogs: AuditLog[];
};

export type Summary = {
  dayNumber: DayNumber;
  soldToday: number;
  dailyLimit: number | null;
  activeHolds: number;
  availableToday: number | null;
  totalSold: number;
  totalRefunded: number;
  issuedCount: number;
  usedCount: number;
  unissuedCount: number | null;
  grossSalesYen: number;
  refundsYen: number;
  netSalesYen: number;
  expectedCashYen: number;
};

export type SaleResult = {
  saleId: string;
  checkoutId: string;
  groupNumber: number;
  ticketNumbers: number[];
  totalYen: number;
  tenderedYen: number;
  changeYen: number;
  purchasedAtMs: number;
};
