import type { DB, IdGen } from "./db.js";
import { bool, jparse, nowText, normalize } from "./db.js";
import type {
  PaymentCompany, Rule, NonReceivableType, ClosurePolicy, Statement,
  OrderSnapshot, MoneyIdentity, AllocationDecision, TrustedStatus,
  ExceptionEvent, MatchGroup, StatementPart, TargetPart,
} from "./types.js";

/**
 * WorkContext：单账户 + 单勾兑日的内存工作区。
 * 引擎在上下文中运行，结果全部落库（追加式版本对象）。
 */
export class WorkContext {
  db: DB;
  idGen: IdGen;
  accountId: string;
  reconDate: string;
  actor: string;

  statements: Statement[] = [];
  orders: OrderSnapshot[] = [];
  paymentCompanies: PaymentCompany[] = [];
  rules: Rule[] = [];
  nonReceivableTypes: NonReceivableType[] = [];
  closurePolicy!: ClosurePolicy;

  groups: MatchGroup[] = [];
  identities = new Map<string, MoneyIdentity>();
  decisions = new Map<string, AllocationDecision>();
  trusted = new Map<string, TrustedStatus>();
  exceptions: ExceptionEvent[] = [];
  manualNR = new Map<string, { id: string; typeId: string; amountCents: number; evidence: string; confirmedBy: string }>();

  touchedRules = new Map<string, number>(); // ruleId|version -> +1
  changedStatementIds = new Set<string>();  // trusted 状态发生变化的流水（供 webhook）

  constructor(db: DB, idGen: IdGen, accountId: string, reconDate: string, actor = "system") {
    this.db = db; this.idGen = idGen; this.accountId = accountId; this.reconDate = reconDate; this.actor = actor;
    this.load();
  }

  private load(): void {
    const q = this.db;
    this.statements = (q.prepare(
      `SELECT * FROM bank_statements WHERE account_id=? AND recon_date=? AND direction='IN' ORDER BY booking_time`
    ).all(this.accountId, this.reconDate) as any[]).map(r => ({
      id: r.id, accountId: r.account_id, reconDate: r.recon_date,
      bankSerialNo: r.bank_serial_no, bookingDate: r.booking_date, bookingTime: r.booking_time,
      payerName: r.payer_name ?? "", payerAccount: r.payer_account ?? "", payerBank: r.payer_bank ?? "",
      memo: r.memo ?? "", amountCents: r.amount_cents, currency: r.currency,
      settlementGroupKey: r.settlement_group_key ?? "",
    }));

    // 当前版本订单快照
    const orderRows = q.prepare(
      `SELECT o.* FROM order_snapshots o
       JOIN (SELECT source_system ss, external_order_id eo, MAX(version) mv FROM order_snapshots GROUP BY source_system, external_order_id) m
       ON o.source_system=m.ss AND o.external_order_id=m.eo AND o.version=m.mv
       WHERE o.superseded_at IS NULL`
    ).all() as any[];
    this.orders = orderRows.map(r => ({
      id: r.id, sourceSystem: r.source_system, externalOrderId: r.external_order_id,
      orderNo: r.order_no, customerCode: r.customer_code ?? "", customerName: r.customer_name,
      amountCents: r.amount_cents, paymentStatus: r.payment_status,
      paymentCompanyId: r.payment_company_id ?? "", paymentSuccessDate: r.payment_success_date ?? "",
      businessDate: r.business_date, version: r.version,
    }));

    // 主数据：取各 id 的最新版本
    const pcRows = q.prepare(
      `SELECT p.* FROM payment_companies p
       JOIN (SELECT id i, MAX(version) mv FROM payment_companies GROUP BY id) m ON p.id=m.i AND p.version=m.mv`
    ).all() as any[];
    this.paymentCompanies = pcRows.map(r => ({
      id: r.id, version: r.version, name: r.name, aliases: jparse<string[]>(r.aliases, []),
      feeRateBps: r.fee_rate_bps, fixedFeeCents: r.fixed_fee_cents,
      calculationLevel: r.calculation_level, rounding: r.rounding,
      effectiveFrom: r.effective_from, enabled: bool(r.enabled),
    }));

    const ruleRows = q.prepare(
      `SELECT r.* FROM rules r
       JOIN (SELECT id i, MAX(version) mv FROM rules GROUP BY id) m ON r.id=m.i AND r.version=m.mv`
    ).all() as any[];
    this.rules = ruleRows.map(r => ({
      id: r.id, version: r.version, layer: r.layer, name: r.name, strategy: r.strategy,
      priority: r.priority, enabled: bool(r.enabled), effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to, params: jparse<Record<string, any>>(r.params, {}),
      conditionText: r.condition_text, actionText: r.action_text, description: r.description,
    }));

    this.nonReceivableTypes = (q.prepare(`SELECT * FROM non_receivable_types ORDER BY sort`).all() as any[]).map(r => ({
      id: r.id, name: r.name, category: r.category, autoRule: r.auto_rule,
      approvalRequired: bool(r.approval_required), evidenceRequired: bool(r.evidence_required), enabled: bool(r.enabled),
    }));

    const pol = q.prepare(`SELECT * FROM closure_policy ORDER BY version DESC LIMIT 1`).get() as any;
    this.closurePolicy = pol
      ? { id: pol.id, version: pol.version, name: pol.name, description: pol.description }
      : { id: "CLOSE-POLICY-001", version: 1, name: "单账户收入资金闭环策略", description: "" };

    // 认领组（含成员）
    const groupRows = q.prepare(`SELECT * FROM match_groups WHERE status='CONFIRMED' ORDER BY created_at`).all() as any[];
    const spRows = q.prepare(`SELECT * FROM statement_parts`).all() as any[];
    const tpRows = q.prepare(`SELECT * FROM target_parts`).all() as any[];
    this.groups = groupRows.map(g => ({
      id: g.id, status: g.status, origin: g.origin, ruleId: g.rule_id ?? "", ruleVersion: g.rule_version ?? 0,
      relationType: g.relation_type, edgeMode: g.edge_mode, note: g.note ?? "",
      createdAt: g.created_at, createdBy: g.created_by,
      statementParts: spRows.filter(p => p.group_id === g.id).map(p => ({ statementId: p.statement_id, amountCents: p.amount_cents })),
      targetParts: tpRows.filter(p => p.group_id === g.id).map(p => ({ targetType: p.target_type, targetId: p.target_id, amountCents: p.amount_cents })),
    }));

    for (const r of q.prepare(`SELECT * FROM money_identities WHERE current=1`).all() as any[]) {
      this.identities.set(r.statement_id, this.mapIdentity(r));
    }
    for (const r of q.prepare(`SELECT * FROM allocation_decisions WHERE current=1`).all() as any[]) {
      this.decisions.set(r.statement_id, this.mapDecision(r));
    }
    for (const r of q.prepare(`SELECT * FROM trusted_statuses WHERE current=1`).all() as any[]) {
      this.trusted.set(r.statement_id, this.mapTrusted(r));
    }
    this.exceptions = (q.prepare(`SELECT * FROM exception_events WHERE status IN ('DETECTED','PROCESSING')`).all() as any[])
      .map(r => this.mapException(r));

    for (const r of q.prepare(`SELECT * FROM manual_nr_assignments WHERE status='CONFIRMED' ORDER BY confirmed_at`).all() as any[]) {
      this.manualNR.set(r.statement_id, { id: r.id, typeId: r.type_id, amountCents: r.amount_cents, evidence: r.evidence, confirmedBy: r.confirmed_by });
    }
  }

  private mapIdentity(r: any): MoneyIdentity {
    return {
      id: r.id, statementId: r.statement_id, version: r.version, signature: r.signature,
      status: r.status, sourceType: r.source_type ?? "", paymentCompanyId: r.payment_company_id ?? "",
      ruleId: r.rule_id ?? "", ruleVersion: r.rule_version ?? 0, evidence: r.evidence ?? "", decidedAt: r.decided_at,
    };
  }
  private mapDecision(r: any): AllocationDecision {
    return {
      id: r.id, statementId: r.statement_id, version: r.version, signature: r.signature,
      status: r.status, coverage: r.coverage, targetType: r.target_type ?? "UNRESOLVED",
      targetIds: jparse<string[]>(r.target_ids, []), groupIds: jparse<string[]>(r.group_ids, []),
      ruleId: r.rule_id ?? "", ruleVersion: r.rule_version ?? 0, basis: r.basis ?? "",
      decidedAt: r.decided_at, decidedBy: r.decided_by,
    };
  }
  private mapTrusted(r: any): TrustedStatus {
    return {
      id: r.id, statementId: r.statement_id, version: r.version, signature: r.signature,
      status: r.status, identityId: r.identity_id ?? undefined, identityVersion: r.identity_version ?? undefined,
      allocationDecisionId: r.allocation_decision_id ?? undefined, allocationDecisionVersion: r.allocation_decision_version ?? undefined,
      openExceptionIds: jparse<string[]>(r.open_exception_ids, []),
      policyId: r.policy_id, policyVersion: r.policy_version, basis: r.basis, evaluatedAt: r.evaluated_at,
    };
  }
  private mapException(r: any): ExceptionEvent {
    return {
      id: r.id, fingerprint: r.fingerprint, type: r.type, ruleId: r.rule_id, ruleVersion: r.rule_version,
      statementIds: jparse<string[]>(r.statement_ids, []), orderIds: jparse<string[]>(r.order_ids, []),
      actualCents: r.actual_cents, expectedCents: r.expected_cents, differenceCents: r.difference_cents,
      location: r.location, responsibility: r.responsibility, basis: r.basis, route: r.route, severity: r.severity,
      blocking: bool(r.blocking), status: r.status, version: r.version, detectedAt: r.detected_at,
      processingAt: r.processing_at ?? undefined, closedAt: r.closed_at ?? undefined,
      closedReason: r.closed_reason ?? undefined, closeEvidence: r.close_evidence ?? undefined,
      history: jparse(r.history, []),
    };
  }

  rule(id: string): Rule | undefined { return this.rules.find(r => r.id === id); }
  paymentCompany(id: string): PaymentCompany | undefined { return this.paymentCompanies.find(p => p.id === id); }

  ruleEnabled(id: string): boolean {
    const r = this.rule(id);
    if (!r || !r.enabled) return false;
    if (r.effectiveFrom && r.effectiveFrom > this.reconDate) return false;
    if (r.effectiveTo && r.effectiveTo < this.reconDate) return false;
    return true;
  }

  // ---- 余额与占用 ----
  activeGroups(): MatchGroup[] { return this.groups.filter(g => g.status === "CONFIRMED"); }
  statementApplied(id: string): number {
    const active = this.activeGroups();
    const ids = new Set(active.map(g => g.id));
    return active
      .flatMap(g => g.statementParts.map(p => ({ groupId: g.id, ...p })))
      .filter(p => ids.has(p.groupId) && p.statementId === id)
      .reduce((s, p) => s + p.amountCents, 0);
  }
  statementAvailable(id: string): number {
    const s = this.statements.find(x => x.id === id);
    if (!s) return 0;
    return Math.max(0, s.amountCents - this.statementApplied(id));
  }
  orderApplied(id: string): number {
    return this.activeGroups().flatMap(g => g.targetParts)
      .filter(p => p.targetType === "BUSINESS_ORDER" && p.targetId === id)
      .reduce((s, p) => s + p.amountCents, 0);
  }
  orderExpectedParts(orders: OrderSnapshot[], pc: PaymentCompany | undefined): TargetPart[] | null {
    if (!pc || !pc.enabled) return null;
    if (pc.calculationLevel !== "BATCH_TOTAL") {
      return orders.map(o => ({
        targetType: "BUSINESS_ORDER" as const, targetId: o.id,
        amountCents: Math.max(0, o.amountCents - roundFeeC(o.amountCents * pc.feeRateBps / 10000, pc.rounding) - pc.fixedFeeCents),
      }));
    }
    const gross = orders.reduce((s, o) => s + o.amountCents, 0);
    const fee = roundFeeC(gross * pc.feeRateBps / 10000, pc.rounding) + pc.fixedFeeCents;
    const total = Math.max(0, gross - fee);
    let allocated = 0;
    return orders.map((o, i) => {
      const amount = i === orders.length - 1 ? total - allocated : Math.round(total * o.amountCents / gross);
      allocated += amount;
      return { targetType: "BUSINESS_ORDER" as const, targetId: o.id, amountCents: amount };
    });
  }
  orderExpected(order: OrderSnapshot): number {
    if (order.paymentStatus !== "支付成功") return order.amountCents;
    const pc = this.paymentCompany(order.paymentCompanyId);
    const part = this.orderExpectedParts([order], pc)?.[0];
    return part?.amountCents ?? order.amountCents;
  }
  orderAvailable(id: string): number {
    const o = this.orders.find(x => x.id === id);
    return o ? Math.max(0, this.orderExpected(o) - this.orderApplied(id)) : 0;
  }
  pendingTransferOrders(): OrderSnapshot[] {
    return this.orders.filter(o => o.paymentStatus === "待确定" && this.orderAvailable(o.id) > 0);
  }
  availableTransferStatements(): Statement[] {
    return this.statements.filter(s => this.identities.get(s.id)?.sourceType === "银行转账" && this.statementAvailable(s.id) > 0);
  }
  openExceptionsForStatement(id: string): ExceptionEvent[] {
    return this.exceptions.filter(e => e.status !== "CLOSED" && e.statementIds.includes(id));
  }

  audit(type: string, object: string, message: string, details = ""): void {
    this.db.prepare(`INSERT INTO audit_events(id,ts,type,object,message,details,actor) VALUES(?,?,?,?,?,?,?)`)
      .run(this.idGen.next("AUD"), nowText(), type, object, message, details, this.actor);
  }

  hitRule(ruleId: string, ruleVersion: number): void {
    const key = `${ruleId}|${ruleVersion}`;
    this.touchedRules.set(key, (this.touchedRules.get(key) ?? 0) + 1);
  }

  flushRuleHits(): void {
    for (const [key, n] of this.touchedRules) {
      const [ruleId, version] = key.split("|");
      this.db.prepare(`INSERT INTO rule_hits(rule_id,rule_version,hit_count) VALUES(?,?,?)
        ON CONFLICT(rule_id,rule_version) DO UPDATE SET hit_count = hit_count + excluded.hit_count`)
        .run(ruleId, Number(version), n);
    }
    this.touchedRules.clear();
  }
}

function roundFeeC(value: number, mode: string): number {
  return mode === "FLOOR" ? Math.floor(value) : mode === "CEIL" ? Math.ceil(value) : Math.round(value);
}

export { normalize };
