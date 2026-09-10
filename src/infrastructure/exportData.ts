import { formatGroupNumber, formatTicketCode } from "../domain/format";
import type { FastpassData } from "../domain/types";

type CsvValue = string | number | boolean | null | undefined;

function safeCell(value: CsvValue): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(headers: string[], rows: CsvValue[][]): string {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(safeCell).join(",")).join("\r\n")}`;
}

export function workspaceJson(data: FastpassData, workspaceId: string): string {
  const workspace = data.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
  const onlyWorkspace = <T extends { workspaceId: string }>(rows: T[]) =>
    rows.filter((row) => row.workspaceId === workspaceId);
  return JSON.stringify(
    {
      exportVersion: 1,
      exportedAtMs: Date.now(),
      workspace,
      sales: onlyWorkspace(data.sales),
      tickets: onlyWorkspace(data.tickets),
      ticketEvents: onlyWorkspace(data.ticketEvents),
      admissions: onlyWorkspace(data.admissions),
      checkinReversals: onlyWorkspace(data.checkinReversals),
      refunds: onlyWorkspace(data.refunds),
      cashboxes: onlyWorkspace(data.cashboxes),
      cashLedger: onlyWorkspace(data.cashLedger),
      expenses: onlyWorkspace(data.expenses),
      cashCounts: onlyWorkspace(data.cashCounts),
      operations: onlyWorkspace(data.operations),
      auditLogs: data.auditLogs.filter((row) => row.workspaceId === workspaceId),
    },
    null,
    2,
  );
}

export function ticketsCsv(data: FastpassData, workspaceId: string): string {
  const sales = new Map(
    data.sales.filter((sale) => sale.workspaceId === workspaceId).map((sale) => [sale.id, sale]),
  );
  return csv(
    ["番号", "グループ", "状態", "購入日時ms", "販売日", "使用日時ms", "払戻日時ms", "更新番号"],
    data.tickets
      .filter((ticket) => ticket.workspaceId === workspaceId)
      .sort((a, b) => a.serialNumber - b.serialNumber)
      .map((ticket) => {
        const sale = sales.get(ticket.saleId);
        return [
          formatTicketCode(ticket.serialNumber),
          sale ? formatGroupNumber(sale.groupNumber) : "",
          ticket.status,
          sale?.purchasedAtMs,
          sale?.dayNumber,
          ticket.usedAtMs,
          ticket.refundedAtMs,
          ticket.version,
        ];
      }),
  );
}

export function salesCsv(data: FastpassData, workspaceId: string): string {
  return csv(
    ["販売ID", "グループ", "販売日", "枚数", "単価", "合計", "預り金", "釣銭", "購入日時ms", "番号", "受渡確認日時ms"],
    data.sales
      .filter((sale) => sale.workspaceId === workspaceId)
      .map((sale) => [
        sale.id,
        formatGroupNumber(sale.groupNumber),
        sale.dayNumber,
        sale.quantity,
        sale.unitPriceYen,
        sale.totalYen,
        sale.tenderedYen,
        sale.changeYen,
        sale.purchasedAtMs,
        sale.ticketNumbers.map(formatTicketCode).join(" "),
        sale.handoverConfirmedAtMs,
      ]),
  );
}

export function refundsCsv(data: FastpassData, workspaceId: string): string {
  const tickets = new Map(data.tickets.map((ticket) => [ticket.id, ticket]));
  return csv(
    ["払戻ID", "番号", "金額", "理由", "処理日時ms", "受渡確認日時ms"],
    data.refunds
      .filter((refund) => refund.workspaceId === workspaceId)
      .map((refund) => [
        refund.id,
        refund.ticketIds
          .map((id) => tickets.get(id))
          .filter((ticket) => ticket !== undefined)
          .map((ticket) => formatTicketCode(ticket.serialNumber))
          .join(" "),
        refund.totalYen,
        refund.reason,
        refund.occurredAtMs,
        refund.handoverConfirmedAtMs,
      ]),
  );
}

export function cashLedgerCsv(data: FastpassData, workspaceId: string): string {
  return csv(
    ["台帳ID", "種類", "金額", "日", "処理日時ms", "出典", "理由", "取消対象"],
    data.cashLedger
      .filter((entry) => entry.workspaceId === workspaceId)
      .map((entry) => [
        entry.id,
        entry.type,
        entry.amountYen,
        entry.dayNumber,
        entry.occurredAtMs,
        `${entry.sourceType}:${entry.sourceId}`,
        entry.reason,
        entry.reversedEntryId,
      ]),
  );
}

export function expensesCsv(data: FastpassData, workspaceId: string): string {
  return csv(
    ["経費ID", "分類", "金額", "支払元", "日", "処理日時ms", "理由", "取消日時ms"],
    data.expenses
      .filter((expense) => expense.workspaceId === workspaceId)
      .map((expense) => [
        expense.id,
        expense.category,
        expense.amountYen,
        expense.paymentSource,
        expense.dayNumber,
        expense.occurredAtMs,
        expense.reason,
        expense.cancelledAtMs,
      ]),
  );
}

export function auditCsv(data: FastpassData, workspaceId: string): string {
  return csv(
    ["履歴ID", "種類", "状態", "処理日時ms", "端末", "操作ID", "内容"],
    data.auditLogs
      .filter((log) => log.workspaceId === workspaceId)
      .map((log) => [log.id, log.type, log.status, log.occurredAtMs, log.deviceId, log.operationId, log.detail]),
  );
}
