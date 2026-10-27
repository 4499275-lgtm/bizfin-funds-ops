import type { DB } from "./db.js";
import { openDb, IdGen } from "./db.js";
import { seedMasterData, FLOWER_SCENE, PROPERTY_SCENE, type Scene } from "./seed.js";
import { previewBankImport, confirmBankImport, type ImportPreview } from "./bankImport.js";
import { syncOrders, type OrderInput, type SyncResult } from "./orderSync.js";
import { WorkContext } from "./context.js";
import { runFourLayers, type RunResult } from "./engine.js";
import { manualAllocate, acceptException, closeException } from "./actions.js";
import { emitEvents } from "../api/webhooks.js";
import { jparse, nowText, yuanToCents } from "./db.js";
import { hashToken } from "../api/auth.js";

/**
 * AppService：面向 API/CLI 的应用服务层。
 * 每个写操作在单事务内完成；评估后自动触发 webhook 事件。
 */
export class AppService {
  db: DB;
  idGen: IdGen;
  actor: string;

  constructor(db: DB, actor = "api") {
    this.db = db;
    this.idGen = new IdGen(db);
    this.actor = actor;
  }

  static open(file: string, actor = "api"): AppService {
    const db = openDb({ file });
    return new AppService(db, actor);
  }

  ensureSeeded(): void {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key='seeded_at'`).get() as any;
    if (!row) seedMasterData(this.db, this.idGen, "bootstrap");
  }

  // ---- 主数据 ----
  ensureAccount(acc: { id: string; bank: string; accountName: string; maskedNo: string }): void {
    const existing = this.db.prepare(`SELECT id FROM accounts WHERE id=?`).get(acc.id);
    if (existing) return;
    this.db.prepare(`INSERT INTO accounts(id,bank,account_name,masked_no,created_at) VALUES(?,?,?,?,?)`)
      .run(acc.id, acc.bank, acc.accountName, acc.maskedNo, nowText());
  }

  addToken(name: string, role: string, token: string): void {
    const hash = hashToken(token);
    this.db.prepare(`INSERT INTO api_tokens(token_hash,name,role,created_at) VALUES(?,?,?,?)`)
      .run(hash, name, role, nowText());
  }

  addWebhook(url: string, secret: string, events: string[]): string {
    const id = this.idGen.next("WH");
    this.db.prepare(`INSERT INTO webhooks(id,url,secret,events,enabled,created_at) VALUES(?,?,?,?,1,?)`)
      .run(id, url, secret, JSON.stringify(events), nowText());
    return id;
  }

  listWebhooks(): any[] {
    return (this.db.prepare(`SELECT id,url,events,enabled,created_at FROM webhooks`).all() as any[])
      .map(h => ({ ...h, events: jparse<string[]>(h.events, []) }));
  }

  // ---- 银行流水导入 ----
  previewBankImport(opts: { accountId: string; reconDate: string; fileName: string; matrix: string[][] }): ImportPreview {
    return previewBankImport(this.db, this.idGen, { ...opts, actor: this.actor });
  }

  confirmBankImport(preview: ImportPreview, matrix: string[][]): { batchId: string; imported: number } {
    const out = confirmBankImport(this.db, this.idGen, preview, { accountId: preview.accountId, reconDate: preview.reconDate, actor: this.actor, matrix });
    this.db.prepare(`INSERT INTO audit_events(id,ts,type,object,message,details,actor) VALUES(?,?,?,?,?,?,?)`)
      .run(this.idGen.next("AUD"), nowText(), "银行流水导入", out.batchId,
        `导入 ${out.imported} 笔标准银行收入流水。`,
        `文件 ${preview.fileName}；总行 ${preview.totalRows}；重复 ${preview.counts.DUPLICATE}；支出 ${preview.counts.OUT_OF_SCOPE}；失败 ${preview.counts.REJECTED}；冲突 ${preview.counts.CONFLICT}`,
        this.actor);
    return out;
  }

  // ---- 订单同步 ----
  syncOrders(sourceSystem: string, orders: OrderInput[], mode = "API 增量同步"): SyncResult {
    const res = syncOrders(this.db, this.idGen, { sourceSystem, orders, mode, actor: this.actor });
    this.db.prepare(`INSERT INTO audit_events(id,ts,type,object,message,details,actor) VALUES(?,?,?,?,?,?,?)`)
      .run(this.idGen.next("AUD"), nowText(), "订单同步", res.runId,
        `同步 ${res.received} 笔订单：新增 ${res.inserted}、更新 ${res.updated}、重复 ${res.duplicate}、拒绝 ${res.rejected}、隔离 ${res.quarantined}。`,
        `来源系统 ${sourceSystem}`, this.actor);
    return res;
  }

  // ---- 评估 ----
  runEvaluation(accountId: string, reconDate: string, statementIds?: string[], source = "api"): RunResult & { webhookQueued: number } {
    const ctx = new WorkContext(this.db, this.idGen, accountId, reconDate, this.actor);
    const result = runFourLayers(ctx, { source, statementIds });
    // webhook 事件
    const events: Array<{ event: string; payload: unknown }> = [];
    for (const sid of ctx.changedStatementIds) {
      const t = ctx.trusted.get(sid);
      const s = ctx.statements.find(x => x.id === sid);
      events.push({
        event: "trusted_status.changed",
        payload: {
          account_id: accountId, recon_date: reconDate, statement_id: sid,
          bank_serial_no: s?.bankSerialNo, amount_cents: s?.amountCents,
          status: t?.status, basis: t?.basis, version: t?.version, evaluated_at: t?.evaluatedAt,
          allocation_decision: t?.allocationDecisionId ? { id: t.allocationDecisionId, version: t.allocationDecisionVersion } : null,
          open_exceptions: t?.openExceptionIds ?? [],
        },
      });
    }
    emitEvents(this.db, this.idGen, events);
    return { ...result, webhookQueued: events.length };
  }

  // ---- 人工动作 ----
  manualAllocate(statementId: string, opts: Parameters<typeof manualAllocate>[2]): ReturnType<typeof manualAllocate> {
    const row = this.db.prepare(`SELECT account_id, recon_date FROM bank_statements WHERE id=?`).get(statementId) as any;
    if (!row) return { ok: false, error: `流水 ${statementId} 不存在` };
    const ctx = new WorkContext(this.db, this.idGen, row.account_id, row.recon_date, this.actor);
    const res = manualAllocate(ctx, statementId, opts);
    if (res.ok) {
      emitEvents(this.db, this.idGen, [...ctx.changedStatementIds].map(sid => ({
        event: "trusted_status.changed",
        payload: { account_id: row.account_id, recon_date: row.recon_date, statement_id: sid, status: ctx.trusted.get(sid)?.status, basis: ctx.trusted.get(sid)?.basis },
      })));
    }
    return res;
  }

  acceptException(exceptionId: string): ReturnType<typeof acceptException> {
    const row = this.db.prepare(`SELECT statement_ids FROM exception_events WHERE id=?`).get(exceptionId) as any;
    if (!row) return { ok: false, error: `异常 ${exceptionId} 不存在` };
    const ids = jparse<string[]>(row.statement_ids, []);
    const stmt = this.db.prepare(`SELECT account_id, recon_date FROM bank_statements WHERE id=?`).get(ids[0] ?? "") as any;
    const ctx = stmt
      ? new WorkContext(this.db, this.idGen, stmt.account_id, stmt.recon_date, this.actor)
      : new NoStatementContext(this.db, this.idGen, this.actor);
    return acceptException(ctx, exceptionId);
  }

  closeException(exceptionId: string, reason: string, evidence: string): ReturnType<typeof closeException> {
    const row = this.db.prepare(`SELECT statement_ids FROM exception_events WHERE id=?`).get(exceptionId) as any;
    if (!row) return { ok: false, error: `异常 ${exceptionId} 不存在` };
    const ids = jparse<string[]>(row.statement_ids, []);
    const stmt = this.db.prepare(`SELECT account_id, recon_date FROM bank_statements WHERE id=?`).get(ids[0] ?? "") as any;
    const ctx = stmt
      ? new WorkContext(this.db, this.idGen, stmt.account_id, stmt.recon_date, this.actor)
      : new NoStatementContext(this.db, this.idGen, this.actor);
    return closeException(ctx, exceptionId, reason, evidence);
  }

  // ---- 演示场景 ----
  seedScene(sceneName: "flower" | "property"): { accountId: string; reconDate: string; evaluation: RunResult } {
    const scene: Scene = sceneName === "flower" ? FLOWER_SCENE : PROPERTY_SCENE;
    this.ensureSeeded();
    this.ensureAccount(scene.account);
    const orders: OrderInput[] = scene.orders.map(o => ({
      externalOrderId: o.externalOrderId, orderNo: o.orderNo, customerCode: o.customerCode,
      customerName: o.customerName, amountCents: o.amountCents, paymentStatus: o.paymentStatus,
      paymentCompanyId: o.paymentCompanyId || undefined, paymentSuccessDate: o.paymentSuccessDate || undefined,
      businessDate: o.businessDate, upstreamUpdatedAt: `${scene.reconDate} 22:00:00`,
    }));
    this.syncOrders(scene.sourceSystem, orders, "演示场景全量");
    const matrix = [["银行交易号", "交易日期", "交易时间", "收入金额", "付款户名", "付款账号", "摘要", "币种", "本方账号尾号", "清算组号"]];
    for (const s of scene.statements) {
      matrix.push([s.bankSerialNo, scene.reconDate, s.bookingTime, (s.amountCents / 100).toFixed(2),
        s.payerName, s.payerAccount ?? `****${Math.floor(1000 + Math.random() * 9000)}`, s.memo, "CNY", "0501", s.settlementGroupKey]);
    }
    const preview = this.previewBankImport({ accountId: scene.account.id, reconDate: scene.reconDate, fileName: `${sceneName}_scene.csv`, matrix });
    const bad = preview.rows.filter(r => r.validationStatus !== "IMPORTED");
    if (bad.length) throw new Error(`场景数据校验失败: ${JSON.stringify(bad.map(r => ({ serial: r.bankSerialNo, status: r.validationStatus, errors: r.errorCodes })))}`);
    this.confirmBankImport(preview, matrix);
    const evaluation = this.runEvaluation(scene.account.id, scene.reconDate, undefined, "演示场景");
    return { accountId: scene.account.id, reconDate: scene.reconDate, evaluation };
  }

  // ---- 查询 ----
  summary(accountId: string, reconDate: string) {
    const rows = this.db.prepare(
      `SELECT t.status AS status, COUNT(*) AS n, SUM(s.amount_cents) AS cents
       FROM trusted_statuses t JOIN bank_statements s ON s.id=t.statement_id
       WHERE t.current=1 AND s.account_id=? AND s.recon_date=? GROUP BY t.status`).all(accountId, reconDate) as any[];
    const statements = (this.db.prepare(`SELECT COUNT(*) n FROM bank_statements WHERE account_id=? AND recon_date=?`).get(accountId, reconDate) as any).n;
    const orders = (this.db.prepare(`SELECT COUNT(*) n FROM order_snapshots WHERE superseded_at IS NULL`).get() as any).n;
    const openExceptions = (this.db.prepare(`SELECT COUNT(*) n FROM exception_events WHERE status IN ('DETECTED','PROCESSING')`).get() as any).n;
    const byStatus: Record<string, { count: number; amountCents: number }> = {};
    for (const r of rows) byStatus[r.status] = { count: r.n, amountCents: r.cents };
    return { accountId, reconDate, statements, orders, openExceptions, byStatus };
  }
}

class NoStatementContext extends WorkContext {
  constructor(db: DB, idGen: IdGen, actor: string) {
    // 订单级异常（L3-008）没有银行流水上下文，使用空上下文
    super(db, idGen, "__none__", "1970-01-01", actor);
  }
}

export { yuanToCents };
