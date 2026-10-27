import type { DB } from "../core/db.js";
import { jparse, nowText } from "../core/db.js";
import { toCsv, readXlsxMatrix } from "./files.js";
import { writeXlsx } from "./files.js";
function orderTemplateMatrix(): string[][] {
  return [[
    "来源订单ID", "业务订单号", "客户编号", "客户名称", "订单金额(元)", "支付状态", "支付公司", "支付成功时间", "业务日期", "上游更新时间",
  ]];
}

/**
 * 报表导出：可信资金状态、勾兑日报表、异常清单、认领组明细、审计、导入模板
 * 统一入口返回 { csv | xlsx buffer | json }
 */

export interface StatementRowView {
  statement: Record<string, unknown>;
  identity: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  exceptions: Record<string, unknown>[];
  trusted: Record<string, unknown> | null;
  orderGroups: Array<{ groupId: string; relationType: string; orderTargets: string[] }>;
}

export function loadDailyRows(db: DB, accountId: string, reconDate: string): StatementRowView[] {
  const stmts = db.prepare(
    `SELECT * FROM bank_statements WHERE account_id=? AND recon_date=? AND direction='IN' ORDER BY booking_time`
  ).all(accountId, reconDate) as any[];
  const out: StatementRowView[] = [];
  for (const s of stmts) {
    const identity = (db.prepare(`SELECT * FROM money_identities WHERE statement_id=? AND current=1`).get(s.id) ?? null) as any;
    const decision = (db.prepare(`SELECT * FROM allocation_decisions WHERE statement_id=? AND current=1`).get(s.id) ?? null) as any;
    const trusted = (db.prepare(`SELECT * FROM trusted_statuses WHERE statement_id=? AND current=1`).get(s.id) ?? null) as any;
    const exceptions = db.prepare(
      `SELECT * FROM exception_events WHERE status IN ('DETECTED','PROCESSING') AND statement_ids LIKE ?`
    ).all(`%"${s.id}"%`) as any[];
    const groups = db.prepare(
      `SELECT g.id, g.relation_type FROM match_groups g JOIN statement_parts sp ON sp.group_id=g.id WHERE g.status='CONFIRMED' AND sp.statement_id=?`
    ).all(s.id) as any[];
    const orderGroups = groups.map(g => ({
      groupId: g.id,
      relationType: g.relation_type,
      orderTargets: (db.prepare(
        `SELECT target_id, amount_cents FROM target_parts WHERE group_id=? AND target_type='BUSINESS_ORDER'`
      ).all(g.id) as any[]).map(t => `${t.target_id}:${(t.amount_cents / 100).toFixed(2)}`),
    }));
    out.push({
      statement: s, identity, decision, exceptions, trusted, orderGroups,
    });
  }
  return out;
}

export function trustedStatusPayload(db: DB, accountId: string, reconDate: string) {
  const account = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(accountId) as any;
  const rows = loadDailyRows(db, accountId, reconDate);
  return {
    account: account ? { id: account.id, bank: account.bank, account_name: account.account_name, masked_no: account.masked_no } : null,
    recon_date: reconDate,
    exported_at: nowText(),
    statements: rows.map(r => ({
      bank_statement_id: r.statement.id,
      bank_serial_no: r.statement.bank_serial_no,
      booking_time: r.statement.booking_time,
      payer_name: r.statement.payer_name,
      payer_bank: r.statement.payer_bank ?? "",
      amount_cents: r.statement.amount_cents,
      memo: r.statement.memo,
      status: r.trusted?.status ?? "Processing",
      money_identity: r.identity ? { id: r.identity.id, version: r.identity.version, status: r.identity.status, source_type: r.identity.source_type, payment_company_id: r.identity.payment_company_id, rule_id: r.identity.rule_id, rule_version: r.identity.rule_version, evidence: r.identity.evidence } : null,
      allocation_decision: r.decision ? { id: r.decision.id, version: r.decision.version, status: r.decision.status, coverage: r.decision.coverage, target_type: r.decision.target_type, target_ids: jparse<string[]>(r.decision.target_ids, []), group_ids: jparse<string[]>(r.decision.group_ids, []), basis: r.decision.basis } : null,
      open_exceptions: r.exceptions.map(e => ({ id: e.id, type: e.type, rule_id: e.rule_id, severity: e.severity, status: e.status, route: e.route, actual_cents: e.actual_cents, expected_cents: e.expected_cents, difference_cents: e.difference_cents })),
      closure_policy: r.trusted ? { id: r.trusted.policy_id, version: r.trusted.policy_version } : null,
      basis: r.trusted?.basis ?? "等待评估",
      evaluated_at: r.trusted?.evaluated_at ?? null,
      status_version: r.trusted?.version ?? 0,
    })),
  };
}

const SUMMARY_HEADER = ["银行交易号", "入账时间", "付款户名", "摘要", "收入金额(元)", "资金身份", "认领状态", "归属目标", "未关闭异常", "可信状态", "闭环依据", "身份版本", "认领决策版本", "状态版本"];

function dailyRowsMatrix(db: DB, accountId: string, reconDate: string): (string | number)[][] {
  const rows = loadDailyRows(db, accountId, reconDate);
  const matrix: (string | number)[][] = [SUMMARY_HEADER];
  for (const r of rows) {
    const s = r.statement as any;
    const i = r.identity as any;
    const d = r.decision as any;
    const t = r.trusted as any;
    matrix.push([
      s.bank_serial_no,
      s.booking_time,
      s.payer_name ?? "",
      s.memo ?? "",
      (s.amount_cents / 100).toFixed(2),
      i ? (i.status === "IDENTIFIED" ? i.source_type : "未识别") : "待评估",
      d ? `${d.status}/${d.coverage}` : "—",
      d ? `${d.target_type}:${jparse<string[]>(d.target_ids, []).join("|") || "—"}` : "—",
      r.exceptions.map(e => e.id).join("|") || "无",
      t?.status ?? "Processing",
      t?.basis ?? "",
      i ? `${i.id} V${i.version}` : "",
      d ? `${d.id} V${d.version}` : "",
      t ? `V${t.version}` : "",
    ]);
  }
  // 汇总
  const total = rows.reduce((sum, r) => sum + (r.statement as any).amount_cents, 0);
  const closed = rows.filter(r => r.trusted?.status === "Closed");
  const blocked = rows.filter(r => r.trusted?.status === "Blocked");
  const processing = rows.filter(r => (r.trusted?.status ?? "Processing") === "Processing");
  matrix.push([]);
  matrix.push(["汇总", `共 ${rows.length} 笔`, `总收入 ${(total / 100).toFixed(2)} 元`,
    `Closed ${closed.length} 笔 / ${(closed.reduce((s, r) => s + (r.statement as any).amount_cents, 0) / 100).toFixed(2)} 元`,
    `Blocked ${blocked.length} 笔`, `Processing ${processing.length} 笔`]);
  return matrix;
}

export function dailyReportCsv(db: DB, accountId: string, reconDate: string): string {
  return toCsv(dailyRowsMatrix(db, accountId, reconDate));
}

export async function dailyReportXlsx(db: DB, accountId: string, reconDate: string): Promise<Buffer> {
  const account = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(accountId) as any;
  return writeXlsx([{ name: `勾兑日报表_${reconDate}`, rows: dailyRowsMatrix(db, accountId, reconDate) }]);
}

export function exceptionsMatrix(db: DB, accountId?: string, _reconDate?: string): (string | number)[][] {
  let rows = db.prepare(`SELECT * FROM exception_events ORDER BY detected_at DESC`).all() as any[];
  if (accountId) {
    const ids = new Set((db.prepare(`SELECT id FROM bank_statements WHERE account_id=?`).all(accountId) as any[]).map(r => r.id));
    rows = rows.filter(r => jparse<string[]>(r.statement_ids, []).some(id => ids.has(id)));
  }
  const matrix: (string | number)[][] = [[
    "异常ID", "类型", "规则", "严重度", "状态", "版本", "银行流水", "业务订单",
    "实际(元)", "理论(元)", "差异(元)", "异常位置", "责任域", "处理路径", "诊断依据", "发现时间", "关闭时间", "关闭原因",
  ]];
  for (const e of rows) {
    matrix.push([
      e.id, e.type, `${e.rule_id} V${e.rule_version}`, e.severity, e.status, e.version,
      jparse<string[]>(e.statement_ids, []).join("|"), jparse<string[]>(e.order_ids, []).join("|"),
      (e.actual_cents / 100).toFixed(2), (e.expected_cents / 100).toFixed(2), (e.difference_cents / 100).toFixed(2),
      e.location, e.responsibility, e.route, e.basis, e.detected_at, e.closed_at ?? "", e.closed_reason ?? "",
    ]);
  }
  return matrix;
}

export function exceptionsCsv(db: DB, accountId?: string, reconDate?: string): string {
  return toCsv(exceptionsMatrix(db, accountId, reconDate));
}

export async function exceptionsXlsx(db: DB, accountId?: string, reconDate?: string): Promise<Buffer> {
  return writeXlsx([{ name: "异常清单", rows: exceptionsMatrix(db, accountId, reconDate) }]);
}

export function groupsMatrix(db: DB, accountId: string, reconDate: string): (string | number)[][] {
  const matrix: (string | number)[][] = [[
    "认领组", "关系", "来源", "规则", "证据模式", "说明", "银行侧成员", "业务订单侧成员", "创建时间", "创建人",
  ]];
  const groups = db.prepare(`SELECT * FROM match_groups WHERE status='CONFIRMED' ORDER BY created_at`).all() as any[];
  for (const g of groups) {
    const sps = db.prepare(`SELECT * FROM statement_parts WHERE group_id=?`).all(g.id) as any[];
    const tps = db.prepare(`SELECT * FROM target_parts WHERE group_id=?`).all(g.id) as any[];
    const stmtIds = new Set(sps.map(p => p.statement_id));
    const belongs = (db.prepare(`SELECT account_id, recon_date FROM bank_statements WHERE id=?`).get(sps[0]?.statement_id ?? "") as any);
    if (!belongs || belongs.account_id !== accountId || belongs.recon_date !== reconDate) continue;
    matrix.push([
      g.id, g.relation_type, g.origin, g.rule_id ? `${g.rule_id} V${g.rule_version}` : "人工确认", g.edge_mode, g.note,
      sps.map(p => `${p.statement_id}:${(p.amount_cents / 100).toFixed(2)}`).join("；"),
      tps.map(p => `${p.target_id}:${(p.amount_cents / 100).toFixed(2)}`).join("；"),
      g.created_at, g.created_by,
    ]);
    void stmtIds;
  }
  return matrix;
}

export function groupsCsv(db: DB, accountId: string, reconDate: string): string {
  return toCsv(groupsMatrix(db, accountId, reconDate));
}

export async function groupsXlsx(db: DB, accountId: string, reconDate: string): Promise<Buffer> {
  return writeXlsx([{ name: "认领组明细", rows: groupsMatrix(db, accountId, reconDate) }]);
}

export function auditMatrix(db: DB, limit = 500): (string | number)[][] {
  const rows = db.prepare(`SELECT * FROM audit_events ORDER BY ts DESC LIMIT ?`).all(limit) as any[];
  const matrix: (string | number)[][] = [["时间", "类型", "对象", "说明", "详情", "操作人"]];
  for (const a of rows) matrix.push([a.ts, a.type, a.object, a.message, a.details, a.actor]);
  return matrix;
}

export function auditCsv(db: DB, limit = 500): string {
  return toCsv(auditMatrix(db, limit));
}

export function bankTemplateCsv(): string {
  return toCsv([[
    "银行交易号", "交易日期", "交易时间", "收支方向", "收入金额", "付款户名", "付款账号", "摘要", "币种", "本方账号尾号", "清算组号",
  ]]);
}

export function orderTemplateCsv(): string {
  return toCsv([[
    "来源订单ID", "业务订单号", "客户编号", "客户名称", "订单金额(元)", "支付状态", "支付公司", "支付成功时间", "业务日期", "上游更新时间",
  ]]);
}

export async function ordersXlsxTemplate(): Promise<Buffer> {
  return writeXlsx([{ name: "订单导入模板", rows: orderTemplateMatrix() }]);
}

export { writeXlsx, readXlsxMatrix };
