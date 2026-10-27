import type { DB, IdGen } from "./db.js";
import { nowText, normalize } from "./db.js";

/**
 * 业务订单同步（API / 文件共用）：
 * - 幂等键 = 来源系统 + 来源订单ID
 * - 校验：支付成功必须有支付公司+成功日期；待确定不得有支付公司
 * - 已确认认领的订单关键字段变化 → 隔离 + 生成 L3-008 冲突异常，不静默覆盖
 */

export interface OrderInput {
  externalOrderId: string;
  orderNo: string;
  customerCode?: string;
  customerName: string;
  amountCents: number;
  paymentStatus: string;
  paymentCompanyId?: string;
  paymentSuccessDate?: string;
  businessDate: string;
  upstreamUpdatedAt: string;
}

export interface SyncRowResult {
  externalOrderId: string;
  status: "INSERTED" | "UPDATED" | "DUPLICATE" | "REJECTED" | "QUARANTINED";
  reasons: string[];
  snapshotId?: string;
  rawRecordId: string;
}

export interface SyncResult {
  runId: string;
  received: number;
  inserted: number;
  updated: number;
  duplicate: number;
  rejected: number;
  quarantined: number;
  rows: SyncRowResult[];
}

const VALID_STATUSES = ["支付成功", "待确定"];

export function validateOrderInput(db: DB, o: OrderInput): string[] {
  const reasons: string[] = [];
  if (!o.externalOrderId?.trim()) reasons.push("缺少来源订单ID");
  if (!o.orderNo?.trim()) reasons.push("缺少业务订单号");
  if (!o.customerName?.trim()) reasons.push("缺少客户名称");
  if (!Number.isInteger(o.amountCents) || o.amountCents <= 0) reasons.push("订单金额必须为正整数分");
  if (!VALID_STATUSES.includes(o.paymentStatus)) reasons.push(`支付状态仅允许：${VALID_STATUSES.join("/")}`);
  if (o.paymentStatus === "支付成功") {
    if (!o.paymentCompanyId?.trim()) reasons.push("支付成功订单缺少支付公司");
    else {
      const pc = db.prepare(`SELECT id FROM payment_companies WHERE id=?`).get(o.paymentCompanyId);
      if (!pc) reasons.push(`支付公司 ${o.paymentCompanyId} 不在主数据中`);
    }
    if (!o.paymentSuccessDate?.trim()) reasons.push("支付成功订单缺少支付成功日期");
  }
  if (o.paymentStatus === "待确定" && o.paymentCompanyId?.trim()) reasons.push("待确定订单不得填写支付公司");
  if (!o.businessDate?.match(/^\d{4}-\d{2}-\d{2}$/)) reasons.push("业务日期格式必须为 YYYY-MM-DD");
  if (!o.upstreamUpdatedAt?.trim()) reasons.push("缺少上游更新时间");
  return reasons;
}

export function syncOrders(db: DB, idGen: IdGen, opts: {
  sourceSystem: string; orders: OrderInput[]; mode: string; actor: string;
}): SyncResult {
  const runId = idGen.next("SYNC");
  const result: SyncResult = {
    runId, received: opts.orders.length, inserted: 0, updated: 0, duplicate: 0, rejected: 0, quarantined: 0, rows: [],
  };
  const insertRun = db.prepare(
    `INSERT INTO order_sync_runs(id,source_system,mode,received,inserted,updated,duplicate,rejected,quarantined,status,created_at,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertRaw = db.prepare(
    `INSERT INTO order_raw_records(id,sync_run_id,source_system,external_order_id,raw,status,reject_reasons,order_snapshot_id)
     VALUES(?,?,?,?,?,?,?,?)`);
  const insertSnapshot = db.prepare(
    `INSERT INTO order_snapshots(id,source_system,external_order_id,order_no,customer_code,customer_name,amount_cents,payment_status,payment_company_id,payment_success_date,business_date,upstream_updated_at,version,raw_record_id,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const supersede = db.prepare(`UPDATE order_snapshots SET superseded_at=? WHERE id=?`);

  for (const o of opts.orders) {
    const reasons = validateOrderInput(db, o);
    if (reasons.length) {
      result.rejected += 1;
      const rawId = idGen.next("ORAW");
      insertRaw.run(rawId, runId, opts.sourceSystem, o.externalOrderId ?? "", JSON.stringify(o), "REJECTED", JSON.stringify(reasons), null);
      result.rows.push({ externalOrderId: o.externalOrderId, status: "REJECTED", reasons, rawRecordId: rawId });
      continue;
    }

    const current = db.prepare(
      `SELECT * FROM order_snapshots WHERE source_system=? AND external_order_id=? ORDER BY version DESC LIMIT 1`
    ).get(opts.sourceSystem, o.externalOrderId) as any;

    if (current) {
      const same = current.order_no === o.orderNo &&
        (current.customer_code ?? "") === (o.customerCode ?? "") &&
        current.customer_name === o.customerName &&
        current.amount_cents === o.amountCents &&
        current.payment_status === o.paymentStatus &&
        (current.payment_company_id ?? "") === (o.paymentCompanyId ?? "") &&
        (current.payment_success_date ?? "") === (o.paymentSuccessDate ?? "") &&
        current.business_date === o.businessDate;
      if (same) {
        result.duplicate += 1;
        const rawId = idGen.next("ORAW");
        insertRaw.run(rawId, runId, opts.sourceSystem, o.externalOrderId, JSON.stringify(o), "STANDARDIZED", "[]", current.id);
        result.rows.push({ externalOrderId: o.externalOrderId, status: "DUPLICATE", reasons: [], snapshotId: current.id, rawRecordId: rawId });
        continue;
      }

      // 冲突保护：已确认认领的订单关键字段变化 → 隔离 + L3-008
      const protectedFields = ["amount_cents", "payment_status", "payment_company_id", "payment_success_date"] as const;
      const changedProtected = protectedFields.some(f => (current[f] ?? "") !== ((o as any)[f] ?? ""));
      const hasActiveEdge = db.prepare(
        `SELECT 1 FROM target_parts tp JOIN match_groups g ON g.id=tp.group_id
         WHERE g.status='CONFIRMED' AND tp.target_type='BUSINESS_ORDER' AND tp.target_id=? LIMIT 1`
      ).get(current.id);
      if (changedProtected && hasActiveEdge) {
        result.quarantined += 1;
        const rawId = idGen.next("ORAW");
        insertRaw.run(rawId, runId, opts.sourceSystem, o.externalOrderId, JSON.stringify(o), "QUARANTINED",
          JSON.stringify(["已确认认领订单的关键字段发生变化，更新被隔离，等待人工处理"]), null);
        raiseOrderConflict(db, idGen, current, o, rawId, opts.actor);
        result.rows.push({ externalOrderId: o.externalOrderId, status: "QUARANTINED", reasons: ["关键字段变化与已确认资金关系冲突，已隔离"], rawRecordId: rawId });
        continue;
      }

      const newVersion = current.version + 1;
      const snapId = idGen.next("OSNP");
      const rawId = idGen.next("ORAW");
      insertRaw.run(rawId, runId, opts.sourceSystem, o.externalOrderId, JSON.stringify(o), "STANDARDIZED", "[]", snapId);
      insertSnapshot.run(snapId, opts.sourceSystem, o.externalOrderId, o.orderNo, o.customerCode ?? "", o.customerName,
        o.amountCents, o.paymentStatus, o.paymentCompanyId ?? "", o.paymentSuccessDate ?? "", o.businessDate,
        o.upstreamUpdatedAt, newVersion, rawId, nowText());
      supersede.run(nowText(), current.id);
      result.updated += 1;
      result.rows.push({ externalOrderId: o.externalOrderId, status: "UPDATED", reasons: [], snapshotId: snapId, rawRecordId: rawId });
    } else {
      const snapId = idGen.next("OSNP");
      const rawId = idGen.next("ORAW");
      insertRaw.run(rawId, runId, opts.sourceSystem, o.externalOrderId, JSON.stringify(o), "STANDARDIZED", "[]", snapId);
      insertSnapshot.run(snapId, opts.sourceSystem, o.externalOrderId, o.orderNo, o.customerCode ?? "", o.customerName,
        o.amountCents, o.paymentStatus, o.paymentCompanyId ?? "", o.paymentSuccessDate ?? "", o.businessDate,
        o.upstreamUpdatedAt, 1, rawId, nowText());
      result.inserted += 1;
      result.rows.push({ externalOrderId: o.externalOrderId, status: "INSERTED", reasons: [], snapshotId: snapId, rawRecordId: rawId });
    }
  }

  insertRun.run(runId, opts.sourceSystem, opts.mode, result.received, result.inserted, result.updated,
    result.duplicate, result.rejected, result.quarantined, result.rejected > 0 ? "部分成功" : "成功", nowText(), opts.actor);
  return result;
}

function raiseOrderConflict(db: DB, idGen: IdGen, current: any, incoming: OrderInput, rawRecordId: string, actor: string): void {
  const fingerprint = `L3-008|已认领订单变化冲突|${current.source_system}:${current.external_order_id}`;
  const existing = db.prepare(`SELECT * FROM exception_events WHERE fingerprint=?`).get(fingerprint) as any;
  const basis = `订单 ${current.order_no}（${current.source_system}/${current.external_order_id}）已存在确认认领，但上游关键字段变化：`
    + `金额 ${current.amount_cents}→${incoming.amountCents}，状态 ${current.payment_status}→${incoming.paymentStatus}，`
    + `支付公司 ${current.payment_company_id ?? ""}→${incoming.paymentCompanyId ?? ""}，成功日 ${current.payment_success_date ?? ""}→${incoming.paymentSuccessDate ?? ""}；原始记录 ${rawRecordId}`;
  if (existing) {
    const history = JSON.parse(existing.history ?? "[]");
    history.push({ version: existing.version, status: existing.status, basis: existing.basis, changedAt: nowText(), actor });
    db.prepare(`UPDATE exception_events SET status='DETECTED', version=?, basis=?, history=?, closed_at=NULL, closed_reason=NULL, close_evidence=NULL, detected_at=? WHERE id=?`)
      .run(existing.version + 1, basis, JSON.stringify(history), nowText(), existing.id);
  } else {
    db.prepare(`INSERT INTO exception_events(id,fingerprint,type,rule_id,rule_version,statement_ids,order_ids,actual_cents,expected_cents,difference_cents,location,responsibility,basis,route,severity,blocking,status,version,detected_at,history)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(idGen.next("EXC"), fingerprint, "已认领订单变化冲突", "L3-008", 1, "[]", JSON.stringify([current.id]),
        0, 0, 0, "业务数据接入", "业务系统",
        basis, "回业务系统核实并审批后重做认领", "高", 1, "DETECTED", 1, nowText(), "[]");
  }
}

export function orderTemplateMatrix(): string[][] {
  return [[
    "来源订单ID", "业务订单号", "客户编号", "客户名称", "订单金额(元)", "支付状态", "支付公司", "支付成功时间", "业务日期", "上游更新时间",
  ]];
}

void normalize;
