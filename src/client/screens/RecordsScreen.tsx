import { useMemo, useState } from "react";
import { NumericKeypad } from "../components/NumericKeypad";
import { getActiveWorkspace } from "../../domain/engine";
import { formatDateTime, formatGroupNumber, formatTicketCode, formatYen } from "../../domain/format";
import type { FastpassData } from "../../domain/types";
import type { Mutate } from "../uiTypes";

type RecordTab = "TICKETS" | "SALES" | "ENTRY" | "REFUNDS" | "AUDIT";

type RecordsScreenProps = {
  data: FastpassData;
  mutate: Mutate;
};

const TABS: Array<{ id: RecordTab; label: string }> = [
  { id: "TICKETS", label: "チケット" },
  { id: "SALES", label: "販売会計" },
  { id: "ENTRY", label: "入場・取消" },
  { id: "REFUNDS", label: "払い戻し" },
  { id: "AUDIT", label: "操作履歴" },
];

const PAGE_SIZE = 30;

export function RecordsScreen({ data, mutate }: RecordsScreenProps) {
  const [tab, setTab] = useState<RecordTab>("TICKETS");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const workspace = getActiveWorkspace(data);
  const searchNumber = search ? Number(search) : null;

  const salesById = useMemo(
    () => new Map(data.sales.filter((sale) => sale.workspaceId === workspace.id).map((sale) => [sale.id, sale])),
    [data.sales, workspace.id],
  );
  const ticketsById = useMemo(
    () => new Map(data.tickets.filter((ticket) => ticket.workspaceId === workspace.id).map((ticket) => [ticket.id, ticket])),
    [data.tickets, workspace.id],
  );

  const changeTab = (next: RecordTab) => {
    setTab(next);
    setSearch("");
    setPage(0);
  };

  const confirmPending = (kind: "SALE" | "REFUND", id: string) => {
    void mutate("CONFIRM_HANDOVER", { kind, sourceId: id }, kind === "SALE" ? "券の受渡しを確認しました。" : "返金の受渡しを確認しました。");
  };

  const rows = (() => {
    if (tab === "TICKETS") {
      return data.tickets
        .filter((ticket) => ticket.workspaceId === workspace.id && (searchNumber === null || ticket.serialNumber === searchNumber))
        .sort((a, b) => b.serialNumber - a.serialNumber)
        .map((ticket) => {
          const sale = salesById.get(ticket.saleId);
          return (
            <article className="record-card" key={ticket.id}>
              <div className="record-card__title"><strong>{formatTicketCode(ticket.serialNumber)}</strong><span className={`status-pill status-pill--${ticket.status.toLowerCase()}`}>{ticket.status === "ISSUED" ? "未使用" : ticket.status === "USED" ? "使用済み" : "払い戻し済み"}</span></div>
              <dl><div><dt>グループ</dt><dd>{sale ? formatGroupNumber(sale.groupNumber) : "—"}</dd></div><div><dt>購入</dt><dd>{formatDateTime(sale?.purchasedAtMs ?? null)}</dd></div><div><dt>販売日</dt><dd>{sale ? `${sale.dayNumber}日目` : "—"}</dd></div><div><dt>使用日時</dt><dd>{formatDateTime(ticket.usedAtMs)}</dd></div><div><dt>更新番号</dt><dd>{ticket.version}</dd></div></dl>
            </article>
          );
        });
    }
    if (tab === "SALES") {
      return data.sales
        .filter((sale) => sale.workspaceId === workspace.id && (searchNumber === null || sale.groupNumber === searchNumber))
        .sort((a, b) => b.purchasedAtMs - a.purchasedAtMs)
        .map((sale) => (
          <article className="record-card" key={sale.id}>
            <div className="record-card__title"><strong>{formatGroupNumber(sale.groupNumber)}</strong><span className={`status-pill ${sale.handoverConfirmedAtMs ? "status-pill--done" : "status-pill--pending"}`}>{sale.handoverConfirmedAtMs ? "受渡確認済み" : "受渡未確認"}</span></div>
            <dl><div><dt>購入日時</dt><dd>{formatDateTime(sale.purchasedAtMs)}</dd></div><div><dt>枚数</dt><dd>{sale.quantity}枚</dd></div><div><dt>販売金額</dt><dd>{formatYen(sale.totalYen)}</dd></div></dl>
            <div className="record-number-list">{sale.ticketNumbers.map((number) => <span key={number}>{formatTicketCode(number)}</span>)}</div>
            {!sale.handoverConfirmedAtMs && <button type="button" className="primary-button record-action" onClick={() => confirmPending("SALE", sale.id)}>実物の受渡しを確認</button>}
          </article>
        ));
    }
    if (tab === "ENTRY") {
      return data.ticketEvents
        .filter((event) => event.workspaceId === workspace.id && (event.type === "CHECKIN" || event.type === "CHECKIN_REVERSAL"))
        .filter((event) => {
          const ticket = ticketsById.get(event.ticketId);
          return searchNumber === null || ticket?.serialNumber === searchNumber;
        })
        .sort((a, b) => b.occurredAtMs - a.occurredAtMs)
        .map((event) => {
          const ticket = ticketsById.get(event.ticketId);
          return <article className="record-card record-card--compact" key={event.id}><div className="record-card__title"><strong>{ticket ? formatTicketCode(ticket.serialNumber) : "不明な券"}</strong><span>{event.type === "CHECKIN" ? "入場" : "使用取消"}</span></div><p>{formatDateTime(event.occurredAtMs)}　{event.reason ?? "理由なし"}</p><small>操作ID {event.operationId}</small></article>;
        });
    }
    if (tab === "REFUNDS") {
      return data.refunds
        .filter((refund) => refund.workspaceId === workspace.id)
        .filter((refund) => searchNumber === null || refund.ticketIds.some((id) => ticketsById.get(id)?.serialNumber === searchNumber))
        .sort((a, b) => b.occurredAtMs - a.occurredAtMs)
        .map((refund) => (
          <article className="record-card" key={refund.id}>
            <div className="record-card__title"><strong>{formatYen(refund.totalYen)}</strong><span className={`status-pill ${refund.handoverConfirmedAtMs ? "status-pill--done" : "status-pill--pending"}`}>{refund.handoverConfirmedAtMs ? "返金受渡済み" : "返金受渡未確認"}</span></div>
            <p>{formatDateTime(refund.occurredAtMs)}　理由：{refund.reason}</p>
            <div className="record-number-list">{refund.ticketIds.map((id) => ticketsById.get(id)).filter((ticket) => ticket !== undefined).map((ticket) => <span key={ticket.id}>{formatTicketCode(ticket.serialNumber)}</span>)}</div>
            {!refund.handoverConfirmedAtMs && <button type="button" className="primary-button record-action" onClick={() => confirmPending("REFUND", refund.id)}>返金受渡しを確認</button>}
          </article>
        ));
    }
    return data.auditLogs
      .filter((log) => log.workspaceId === workspace.id || log.workspaceId === null)
      .sort((a, b) => b.occurredAtMs - a.occurredAtMs)
      .map((log) => <article className="record-card record-card--compact" key={log.id}><div className="record-card__title"><strong>{log.type}</strong><span>{log.status}</span></div><p>{formatDateTime(log.occurredAtMs)}　{log.detail}</p><small>{log.operationId ? `操作ID ${log.operationId}` : "管理操作"}</small></article>);
  })();

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visibleRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="screen records-screen">
      <div className="record-tabs" role="tablist" aria-label="記録種別">
        {TABS.map((item) => <button type="button" role="tab" aria-selected={tab === item.id} key={item.id} className={tab === item.id ? "active" : ""} onClick={() => changeTab(item.id)}>{item.label}</button>)}
      </div>
      <div className="two-column records-layout">
        <section className="work-panel record-work-panel">
          <div className="section-heading compact-heading"><div><p className="eyebrow">本番／テスト領域を混在させません</p><h2>{TABS.find((item) => item.id === tab)?.label}</h2></div><strong>{rows.length}件</strong></div>
          <div className="record-list">{visibleRows.length > 0 ? visibleRows : <div className="empty-state"><span aria-hidden="true">⌕</span><strong>該当する記録がありません</strong><p>検索条件を消して確認してください。</p></div>}</div>
          {pageCount > 1 && <div className="pagination"><button type="button" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>前へ</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)}>次へ</button></div>}
        </section>
        <aside className="side-panel">
          <div className="number-display"><span>{tab === "SALES" ? "グループ番号検索" : "チケット番号検索"}</span><strong>{tab === "SALES" ? `G-${search || "____"}` : `HC-${search || "___"}`}</strong></div>
          {tab === "AUDIT" ? <div className="empty-state compact-empty"><span aria-hidden="true">i</span><strong>このタブは番号検索なし</strong><p>日時の新しい順に表示します。</p></div> : <NumericKeypad value={search} onChange={(value) => { setSearch(value); setPage(0); }} onConfirm={() => setPage(0)} confirmLabel="検索" maxDigits={8} />}
          {search && <button type="button" className="secondary-button full-button" onClick={() => { setSearch(""); setPage(0); }}>検索を解除</button>}
        </aside>
      </div>
    </div>
  );
}
