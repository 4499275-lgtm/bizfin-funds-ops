import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppService } from "../core/service.js";
import { yuanToCents, type DB } from "../core/db.js";
import { makeAuthHook, requireRole } from "./auth.js";
import { deliverPending } from "./webhooks.js";
import { parseCsv, readXlsxMatrix, toCsv } from "../export/files.js";
import {
  trustedStatusPayload, dailyReportCsv, dailyReportXlsx,
  exceptionsCsv, exceptionsXlsx, groupsCsv, groupsXlsx, auditCsv,
  bankTemplateCsv, orderTemplateCsv, ordersXlsxTemplate, loadDailyRows,
} from "../export/reports.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  db: DB;
  port?: number;
  host?: string;
  publicDir?: string;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  const svc = new AppService(opts.db, "api");
  svc.ensureSeeded();

  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });
  const publicDir = opts.publicDir ?? (existsSync(join(process.cwd(), "public")) ? join(process.cwd(), "public") : join(__dirname, "../../../public"));
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: "/", decorateReply: true });
  }

  app.addHook("onRequest", makeAuthHook(opts.db));

  const ok = (data: unknown = null) => ({ ok: true, data });
  const err = (reply: any, code: number, message: string) => reply.code(code).send({ ok: false, error: message });

  app.get("/health", async () => ({ status: "up", version: "3.0.0", time: new Date().toISOString() }));

  /* ---------- 账户 ---------- */
  app.get("/api/v1/accounts", async () => {
    return ok((opts.db.prepare(`SELECT * FROM accounts ORDER BY id`).all() as any[]).map(a => ({
      id: a.id, bank: a.bank, accountName: a.account_name, maskedNo: a.masked_no,
    })));
  });
  app.post("/api/v1/accounts", async (req, reply) => {
    if (!requireRole(req, reply, "write")) return;
    const b = req.body as any;
    if (!b?.id || !b?.bank || !b?.accountName || !b?.maskedNo) return err(reply, 400, "id/bank/accountName/maskedNo 必填");
    svc.ensureAccount(b);
    return ok();
  });

  /* ---------- 银行流水导入（API 接入） ---------- */
  app.post("/api/v1/bank-statements/import", async (req, reply) => {
    if (!requireRole(req, reply, "write")) return;
    let accountId: string | undefined, reconDate: string | undefined, fileName = "upload", dryRun = false, matrix: string[][] | null = null;
    const ctype = String(req.headers["content-type"] ?? "");
    if (ctype.includes("multipart/form-data")) {
      const parts = req.parts();
      for await (const part of parts as any) {
        if (part.type === "file") {
          const buf = await part.toBuffer();
          fileName = part.filename ?? fileName;
          matrix = part.filename?.toLowerCase().endsWith(".csv")
            ? parseCsv(buf.toString("utf8"))
            : await readXlsxMatrix(buf);
        } else if (part.type === "field") {
          if (part.fieldname === "accountId") accountId = part.value;
          if (part.fieldname === "reconDate") reconDate = part.value;
          if (part.fieldname === "dryRun") dryRun = String(part.value) === "true";
        }
      }
    } else {
      const b = req.body as any;
      accountId = b?.accountId; reconDate = b?.reconDate; dryRun = Boolean(b?.dryRun);
      if (Array.isArray(b?.rows)) matrix = b.rows as string[][];
      else if (typeof b?.csv === "string") matrix = parseCsv(b.csv);
      fileName = b?.fileName ?? fileName;
    }
    if (!accountId || !reconDate) return err(reply, 400, "accountId 与 reconDate 必填");
    if (!matrix) return err(reply, 400, "缺少文件或 rows/csv 数据");
    const preview = svc.previewBankImport({ accountId, reconDate, fileName, matrix });
    if (dryRun) {
      return ok({ dryRun: true, batchId: preview.batchId, counts: preview.counts, templateId: preview.templateId, fileHash: preview.fileHash, rows: preview.rows });
    }
    const imported = svc.confirmBankImport(preview, matrix);
    return ok({ counts: preview.counts, ...imported });
  });

  /* ---------- 订单同步（API 接入） ---------- */
  app.post("/api/v1/orders/sync", async (req, reply) => {
    if (!requireRole(req, reply, "write")) return;
    const b = req.body as any;
    if (!b?.sourceSystem || !Array.isArray(b?.orders)) return err(reply, 400, "sourceSystem 与 orders[] 必填");
    const orders = b.orders.map((o: any) => ({
      externalOrderId: String(o.externalOrderId ?? o["来源订单ID"] ?? ""),
      orderNo: String(o.orderNo ?? o["业务订单号"] ?? ""),
      customerCode: o.customerCode != null ? String(o.customerCode) : undefined,
      customerName: String(o.customerName ?? o["客户名称"] ?? ""),
      amountCents: Number.isInteger(o.amountCents) ? o.amountCents : yuanToCents(o.amountCents ?? o["订单金额(元)"]),
      paymentStatus: String(o.paymentStatus ?? o["支付状态"] ?? ""),
      paymentCompanyId: o.paymentCompanyId ? String(o.paymentCompanyId) : (o["支付公司"] ? String(o["支付公司"]) : undefined),
      paymentSuccessDate: o.paymentSuccessDate ? String(o.paymentSuccessDate) : (o["支付成功时间"] ? String(o["支付成功时间"]) : undefined),
      businessDate: String(o.businessDate ?? o["业务日期"] ?? ""),
      upstreamUpdatedAt: String(o.upstreamUpdatedAt ?? o["上游更新时间"] ?? ""),
    }));
    const res = svc.syncOrders(b.sourceSystem, orders, b.mode ?? "API 增量同步");
    return ok(res);
  });

  /* ---------- 评估 ---------- */
  app.post("/api/v1/evaluations/run", async (req, reply) => {
    if (!requireRole(req, reply, "write")) return;
    const b = req.body as any;
    if (!b?.accountId || !b?.reconDate) return err(reply, 400, "accountId 与 reconDate 必填");
    const res = svc.runEvaluation(b.accountId, b.reconDate, b.statementIds, "api");
    return ok(res);
  });

  /* ---------- 查询 ---------- */
  app.get("/api/v1/bank-statements", async (req: any) => {
    const q = req.query;
    const rows = loadDailyRows(opts.db, q.accountId, q.reconDate);
    return ok(rows.map(r => ({
      id: r.statement.id, bankSerialNo: r.statement.bank_serial_no, bookingTime: r.statement.booking_time,
      payerName: r.statement.payer_name, payerAccount: r.statement.payer_account, payerBank: r.statement.payer_bank,
      memo: r.statement.memo, amountCents: r.statement.amount_cents, settlementGroupKey: r.statement.settlement_group_key,
      identity: r.identity && {
        id: r.identity.id, version: r.identity.version, status: r.identity.status, sourceType: r.identity.source_type,
        paymentCompanyId: r.identity.payment_company_id, ruleId: r.identity.rule_id, ruleVersion: r.identity.rule_version, evidence: r.identity.evidence,
      },
      decision: r.decision && {
        id: r.decision.id, version: r.decision.version, status: r.decision.status, coverage: r.decision.coverage,
        targetType: r.decision.target_type, targetIds: JSON.parse(String(r.decision.target_ids ?? "[]")),
        groupIds: JSON.parse(String(r.decision.group_ids ?? "[]")), basis: String(r.decision.basis ?? ""),
      },
      exceptions: r.exceptions.map(e => ({ id: e.id, type: e.type, status: e.status, severity: e.severity, route: e.route })),
      trusted: r.trusted && {
        id: r.trusted.id, version: r.trusted.version, status: r.trusted.status, basis: r.trusted.basis, evaluatedAt: r.trusted.evaluated_at,
      },
      orderGroups: r.orderGroups,
    })));
  });

  app.get("/api/v1/orders", async () => {
    const rows = opts.db.prepare(
      `SELECT o.* FROM order_snapshots o
       JOIN (SELECT source_system ss, external_order_id eo, MAX(version) mv FROM order_snapshots GROUP BY source_system, external_order_id) m
       ON o.source_system=m.ss AND o.external_order_id=m.eo AND o.version=m.mv WHERE o.superseded_at IS NULL ORDER BY o.order_no`).all() as any[];
    return ok(rows.map(r => ({
      id: r.id, sourceSystem: r.source_system, externalOrderId: r.external_order_id, orderNo: r.order_no,
      customerCode: r.customer_code, customerName: r.customer_name, amountCents: r.amount_cents,
      paymentStatus: r.payment_status, paymentCompanyId: r.payment_company_id,
      paymentSuccessDate: r.payment_success_date, businessDate: r.business_date, version: r.version,
    })));
  });

  app.get("/api/v1/trusted-statuses", async (req: any) => {
    const q = req.query;
    const rows = opts.db.prepare(
      `SELECT t.*, s.bank_serial_no, s.payer_name, s.amount_cents FROM trusted_statuses t
       JOIN bank_statements s ON s.id=t.statement_id
       WHERE s.account_id=? AND s.recon_date=? AND t.current=1 ORDER BY s.booking_time`).all(q.accountId, q.reconDate) as any[];
    return ok(rows.map(r => ({
      id: r.id, statementId: r.statement_id, bankSerialNo: r.bank_serial_no, payerName: r.payer_name,
      amountCents: r.amount_cents, version: r.version, status: r.status,
      identityId: r.identity_id, identityVersion: r.identity_version,
      allocationDecisionId: r.allocation_decision_id, allocationDecisionVersion: r.allocation_decision_version,
      openExceptionIds: JSON.parse(r.open_exception_ids ?? "[]"),
      policy: { id: r.policy_id, version: r.policy_version },
      basis: r.basis, evaluatedAt: r.evaluated_at,
    })));
  });

  app.get("/api/v1/exceptions", async (req: any) => {
    const q = req.query;
    let rows = opts.db.prepare(`SELECT * FROM exception_events ORDER BY detected_at DESC`).all() as any[];
    if (q.accountId) {
      const ids = new Set((opts.db.prepare(`SELECT id FROM bank_statements WHERE account_id=?`).all(q.accountId) as any[]).map(r => r.id));
      rows = rows.filter(r => JSON.parse(r.statement_ids ?? "[]").some((id: string) => ids.has(id)));
    }
    if (q.status) rows = rows.filter(r => r.status === q.status);
    return ok(rows.map(r => ({
      id: r.id, type: r.type, ruleId: r.rule_id, ruleVersion: r.rule_version,
      statementIds: JSON.parse(r.statement_ids ?? "[]"), orderIds: JSON.parse(r.order_ids ?? "[]"),
      actualCents: r.actual_cents, expectedCents: r.expected_cents, differenceCents: r.difference_cents,
      location: r.location, responsibility: r.responsibility, basis: r.basis, route: r.route, severity: r.severity,
      status: r.status, version: r.version, detectedAt: r.detected_at, closedAt: r.closed_at,
      closedReason: r.closed_reason, closeEvidence: r.close_evidence, history: JSON.parse(r.history ?? "[]"),
    })));
  });

  app.get("/api/v1/match-groups", async (req: any) => {
    const q = req.query;
    const groups = opts.db.prepare(`SELECT * FROM match_groups WHERE status='CONFIRMED' ORDER BY created_at`).all() as any[];
    const out = [];
    for (const g of groups) {
      const sps = opts.db.prepare(`SELECT * FROM statement_parts WHERE group_id=?`).all(g.id) as any[];
      const first = sps[0] ? (opts.db.prepare(`SELECT account_id, recon_date FROM bank_statements WHERE id=?`).get(sps[0].statement_id) as any) : null;
      if (q.accountId && (!first || first.account_id !== q.accountId)) continue;
      if (q.reconDate && (!first || first.recon_date !== q.reconDate)) continue;
      out.push({
        id: g.id, origin: g.origin, ruleId: g.rule_id, ruleVersion: g.rule_version, relationType: g.relation_type,
        edgeMode: g.edge_mode, note: g.note, createdAt: g.created_at, createdBy: g.created_by,
        statementParts: sps.map(p => ({ statementId: p.statement_id, amountCents: p.amount_cents })),
        targetParts: (opts.db.prepare(`SELECT * FROM target_parts WHERE group_id=?`).all(g.id) as any[])
          .map(p => ({ targetType: p.target_type, targetId: p.target_id, amountCents: p.amount_cents })),
      });
    }
    return ok(out);
  });

  app.get("/api/v1/evaluations", async (req: any) => {
    const q = req.query;
    const rows = opts.db.prepare(`SELECT * FROM evaluations WHERE account_id=? AND recon_date=? ORDER BY started_at DESC LIMIT 100`).all(q.accountId, q.reconDate) as any[];
    return ok(rows.map(r => ({ id: r.id, source: r.source, statementIds: JSON.parse(r.statement_ids ?? "[]"), stats: r.stats ? JSON.parse(r.stats) : null, startedAt: r.started_at, finishedAt: r.finished_at })));
  });

  app.get("/api/v1/summary", async (req: any) => ok(svc.summary(req.query.accountId, req.query.reconDate)));

  app.get("/api/v1/audit-events", async (req: any) => {
    const rows = opts.db.prepare(`SELECT * FROM audit_events ORDER BY ts DESC LIMIT ?`).all(Math.min(Number(req.query.limit ?? 200), 1000)) as any[];
    return ok(rows.map(r => ({ id: r.id, ts: r.ts, type: r.type, object: r.object, message: r.message, details: r.details, actor: r.actor })));
  });

  app.get("/api/v1/import-batches", async (req: any) => {
    const rows = opts.db.prepare(`SELECT * FROM bank_import_batches WHERE account_id=? ORDER BY created_at DESC`).all(req.query.accountId) as any[];
    return ok(rows.map(r => ({
      id: r.id, reconDate: r.recon_date, fileName: r.file_name, fileHash: r.file_hash, templateId: r.template_id,
      status: r.status, totalRows: r.total_rows, importedRows: r.imported_rows, duplicateRows: r.duplicate_rows,
      outOfScopeRows: r.out_of_scope_rows, rejectedRows: r.rejected_rows, conflictRows: r.conflict_rows, createdAt: r.created_at,
    })));
  });
  app.get("/api/v1/import-batches/:id/rows", async (req: any, reply) => {
    const rows = opts.db.prepare(`SELECT * FROM bank_raw_rows WHERE batch_id=? ORDER BY row_no`).all(req.params.id) as any[];
    if (!rows.length) return err(reply, 404, "批次不存在或没有原始行");
    return ok(rows.map(r => ({
      id: r.id, rowNo: r.row_no, rawCells: JSON.parse(r.raw_cells ?? "{}"), validationStatus: r.validation_status,
      errorCodes: JSON.parse(r.error_codes ?? "[]"), standardStatementId: r.standard_statement_id,
    })));
  });

  /* ---------- 人工动作 ---------- */
  app.post("/api/v1/statements/:id/allocate", async (req: any, reply) => {
    if (!requireRole(req, reply, "write")) return;
    const b = req.body as any;
    const res = svc.manualAllocate(req.params.id, {
      orderAllocations: Array.isArray(b?.orderAllocations)
        ? b.orderAllocations.map((a: any) => ({ orderId: a.orderId, amountCents: Number.isInteger(a.amountCents) ? a.amountCents : yuanToCents(a.amount) }))
        : undefined,
      nonReceivableTypeId: b?.nonReceivableTypeId,
      evidence: b?.evidence,
      note: b?.note,
    });
    if (!res.ok) return err(reply, 400, res.error!);
    return ok(res.result);
  });

  app.post("/api/v1/exceptions/:id/accept", async (req: any, reply) => {
    if (!requireRole(req, reply, "write")) return;
    const res = svc.acceptException(req.params.id);
    if (!res.ok) return err(reply, 400, res.error!);
    return ok();
  });

  app.post("/api/v1/exceptions/:id/close", async (req: any, reply) => {
    if (!requireRole(req, reply, "write")) return;
    const b = req.body as any;
    const res = svc.closeException(req.params.id, b?.reason ?? "", b?.evidence ?? "");
    if (!res.ok) return err(reply, 400, res.error!);
    return ok();
  });

  /* ---------- 规则中心（版本化） ---------- */
  app.get("/api/v1/rules", async () => {
    const rows = opts.db.prepare(
      `SELECT r.* FROM rules r JOIN (SELECT id i, MAX(version) mv FROM rules GROUP BY id) m ON r.id=m.i AND r.version=m.mv ORDER BY r.layer, r.priority`).all() as any[];
    return ok(rows.map(r => ({
      id: r.id, version: r.version, layer: r.layer, name: r.name, strategy: r.strategy, priority: r.priority,
      enabled: !!r.enabled, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, params: JSON.parse(r.params ?? "{}"),
      conditionText: r.condition_text, actionText: r.action_text, description: r.description,
      hitCount: (opts.db.prepare(`SELECT hit_count FROM rule_hits WHERE rule_id=? AND rule_version=?`).get(r.id, r.version) as any)?.hit_count ?? 0,
    })));
  });

  app.post("/api/v1/rules/:id/versions", async (req: any, reply) => {
    if (!requireRole(req, reply, "admin")) return;
    const b = req.body as any;
    const cur = opts.db.prepare(`SELECT * FROM rules WHERE id=? ORDER BY version DESC LIMIT 1`).get(req.params.id) as any;
    if (!cur) return err(reply, 404, "规则不存在");
    const v = cur.version + 1;
    opts.db.prepare(
      `INSERT INTO rules(id,version,layer,name,strategy,priority,enabled,effective_from,effective_to,params,condition_text,action_text,description,created_at,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(cur.id, v, cur.layer, cur.name, cur.strategy,
        b.priority ?? cur.priority, b.enabled ?? cur.enabled,
        b.effectiveFrom ?? cur.effective_from, b.effectiveTo ?? cur.effective_to,
        b.params ? JSON.stringify(b.params) : cur.params,
        b.conditionText ?? cur.condition_text, b.actionText ?? cur.action_text, cur.description,
        new Date().toISOString().slice(0, 19).replace("T", " "), (req as any).auth?.name ?? "api");
    opts.db.prepare(`UPDATE rules SET superseded_at=? WHERE id=? AND version=?`).run(new Date().toISOString().slice(0, 19).replace("T", " "), cur.id, cur.version);
    return ok({ id: cur.id, version: v });
  });

  app.get("/api/v1/payment-companies", async () => {
    const rows = opts.db.prepare(
      `SELECT p.* FROM payment_companies p JOIN (SELECT id i, MAX(version) mv FROM payment_companies GROUP BY id) m ON p.id=m.i AND p.version=m.mv`).all() as any[];
    return ok(rows.map(r => ({
      id: r.id, version: r.version, name: r.name, aliases: JSON.parse(r.aliases ?? "[]"),
      feeRateBps: r.fee_rate_bps, fixedFeeCents: r.fixed_fee_cents, calculationLevel: r.calculation_level,
      rounding: r.rounding, effectiveFrom: r.effective_from, enabled: !!r.enabled,
    })));
  });

  app.post("/api/v1/payment-companies/:id/versions", async (req: any, reply) => {
    if (!requireRole(req, reply, "admin")) return;
    const b = req.body as any;
    const cur = opts.db.prepare(`SELECT * FROM payment_companies WHERE id=? ORDER BY version DESC LIMIT 1`).get(req.params.id) as any;
    if (!cur) return err(reply, 404, "支付公司不存在");
    const v = cur.version + 1;
    opts.db.prepare(
      `INSERT INTO payment_companies(id,version,name,aliases,fee_rate_bps,fixed_fee_cents,calculation_level,rounding,effective_from,enabled,created_at,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(cur.id, v, cur.name, cur.aliases, b.feeRateBps ?? cur.fee_rate_bps, b.fixedFeeCents ?? cur.fixed_fee_cents,
        b.calculationLevel ?? cur.calculation_level, b.rounding ?? cur.rounding, b.effectiveFrom ?? cur.effective_from,
        b.enabled ?? cur.enabled, new Date().toISOString().slice(0, 19).replace("T", " "), (req as any).auth?.name ?? "api");
    opts.db.prepare(`UPDATE payment_companies SET superseded_at=? WHERE id=? AND version=?`).run(new Date().toISOString().slice(0, 19).replace("T", " "), cur.id, cur.version);
    return ok({ id: cur.id, version: v });
  });

  app.get("/api/v1/non-receivable-types", async () => {
    const rows = opts.db.prepare(`SELECT * FROM non_receivable_types ORDER BY sort`).all() as any[];
    return ok(rows.map(r => ({
      id: r.id, name: r.name, category: r.category, autoRule: r.auto_rule,
      approvalRequired: !!r.approval_required, evidenceRequired: !!r.evidence_required, enabled: !!r.enabled,
    })));
  });

  app.get("/api/v1/closure-policy", async () => {
    const r = opts.db.prepare(`SELECT * FROM closure_policy ORDER BY version DESC LIMIT 1`).get() as any;
    return ok(r ? { id: r.id, version: r.version, name: r.name, description: r.description, effectiveFrom: r.effective_from } : null);
  });

  /* ---------- 报表导出（API 输出） ---------- */
  app.get("/api/v1/export/trusted-status", async (req: any, reply) => {
    const q = req.query;
    if (!q.accountId || !q.reconDate) return err(reply, 400, "accountId 与 reconDate 必填");
    const payload = trustedStatusPayload(opts.db, q.accountId, q.reconDate);
    if (q.format === "csv") {
      const rows: any[][] = [["银行交易号", "状态", "金额(分)", "身份对象", "认领决策", "未关闭异常", "闭环依据", "评估时间", "状态版本"]];
      for (const s of payload.statements) {
        rows.push([s.bank_serial_no, s.status, s.amount_cents,
          s.money_identity ? `${s.money_identity.id} V${s.money_identity.version}` : "",
          s.allocation_decision ? `${s.allocation_decision.id} V${s.allocation_decision.version}` : "",
          s.open_exceptions.map((e: any) => e.id).join("|"), s.basis, s.evaluated_at ?? "", s.status_version]);
      }
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="trusted_status_${q.reconDate}.csv"`);
      return toCsv(rows);
    }
    if (q.format === "xlsx") {
      const rows: any[][] = [["银行交易号", "状态", "金额(分)", "身份对象", "认领决策", "未关闭异常", "闭环依据", "评估时间", "状态版本"]];
      for (const s of payload.statements) {
        rows.push([s.bank_serial_no, s.status, s.amount_cents,
          s.money_identity ? `${s.money_identity.id} V${s.money_identity.version}` : "",
          s.allocation_decision ? `${s.allocation_decision.id} V${s.allocation_decision.version}` : "",
          s.open_exceptions.map((e: any) => e.id).join("|"), s.basis, s.evaluated_at ?? "", s.status_version]);
      }
      const buf = await dailyReportXlsxMatrix(rows, `可信资金状态_${q.reconDate}`);
      reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("content-disposition", `attachment; filename="trusted_status_${q.reconDate}.xlsx"`);
      return buf;
    }
    return payload;
  });

  app.get("/api/v1/export/daily-report", async (req: any, reply) => {
    const q = req.query;
    if (!q.accountId || !q.reconDate) return err(reply, 400, "accountId 与 reconDate 必填");
    if (q.format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="daily_report_${q.reconDate}.csv"`);
      return dailyReportCsv(opts.db, q.accountId, q.reconDate);
    }
    if (q.format === "xlsx") {
      const buf = await dailyReportXlsx(opts.db, q.accountId, q.reconDate);
      reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("content-disposition", `attachment; filename="daily_report_${q.reconDate}.xlsx"`);
      return buf;
    }
    return trustedStatusPayload(opts.db, q.accountId, q.reconDate);
  });

  app.get("/api/v1/export/exceptions", async (req: any, reply) => {
    if (req.query.format === "xlsx") {
      const buf = await exceptionsXlsx(opts.db, req.query.accountId);
      reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("content-disposition", `attachment; filename="exceptions.xlsx"`);
      return buf;
    }
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="exceptions.csv"`);
    return exceptionsCsv(opts.db, req.query.accountId);
  });

  app.get("/api/v1/export/match-groups", async (req: any, reply) => {
    if (!req.query.accountId || !req.query.reconDate) return err(reply, 400, "accountId 与 reconDate 必填");
    if (req.query.format === "xlsx") {
      const buf = await groupsXlsx(opts.db, req.query.accountId, req.query.reconDate);
      reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("content-disposition", `attachment; filename="match_groups_${req.query.reconDate}.xlsx"`);
      return buf;
    }
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="match_groups_${req.query.reconDate}.csv"`);
    return groupsCsv(opts.db, req.query.accountId, req.query.reconDate);
  });

  app.get("/api/v1/export/audit", async (req: any, reply) => {
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="audit.csv"`);
    return auditCsv(opts.db, Math.min(Number(req.query.limit ?? 500), 5000));
  });

  /* ---------- 导入模板 ---------- */
  app.get("/api/v1/templates/bank.csv", async (_req, reply) => {
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="bank_template.csv"`);
    return bankTemplateCsv();
  });
  app.get("/api/v1/templates/orders.csv", async (_req, reply) => {
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="orders_template.csv"`);
    return orderTemplateCsv();
  });
  app.get("/api/v1/templates/orders.xlsx", async (_req, reply) => {
    const buf = await ordersXlsxTemplate();
    reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("content-disposition", `attachment; filename="orders_template.xlsx"`);
    return buf;
  });

  /* ---------- Webhook 管理 ---------- */
  app.get("/api/v1/webhooks", async () => ok(svc.listWebhooks()));
  app.post("/api/v1/webhooks", async (req: any, reply) => {
    if (!requireRole(req, reply, "admin")) return;
    const b = req.body as any;
    if (!b?.url || !b?.secret || !Array.isArray(b?.events)) return err(reply, 400, "url/secret/events[] 必填");
    return ok({ id: svc.addWebhook(b.url, b.secret, b.events) });
  });
  app.get("/api/v1/webhooks/deliveries", async (req: any) => {
    const rows = opts.db.prepare(`SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?`)
      .all(Math.min(Number(req.query.limit ?? 100), 500)) as any[];
    return ok(rows.map(r => ({ id: r.id, webhookId: r.webhook_id, event: r.event, status: r.status, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at, deliveredAt: r.delivered_at })));
  });
  app.post("/api/v1/webhooks/flush", async (req: any, reply) => {
    if (!requireRole(req, reply, "write")) return;
    return ok(await deliverPending(opts.db, svc.idGen));
  });

  /* ---------- 演示 ---------- */
  app.post("/api/v1/demo/seed", async (req: any, reply) => {
    if (!requireRole(req, reply, "write")) return;
    const scene = (req.body as any)?.scene === "property" ? "property" : "flower";
    return ok(svc.seedScene(scene));
  });

  async function dailyReportXlsxMatrix(rows: any[][], name: string) {
    const { writeXlsx } = await import("../export/files.js");
    return writeXlsx([{ name, rows }]);
  }

  return app;
}
