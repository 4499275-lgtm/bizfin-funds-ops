import type { WorkContext } from "./context.js";
import type {
  IdentifyOutcome, MoneyIdentity, AllocationDecision, TrustedStatus,
  ExceptionEvent, MatchGroup, StatementPart, TargetPart, Statement, OrderSnapshot,
} from "./types.js";
import { jparse, jstr, normalize, nowText, settlementBusinessDates } from "./db.js";

/* ================= 第一层：资金识别 ================= */

export function identityResult(ctx: WorkContext, s: Statement): IdentifyOutcome {
  const text = `${s.payerName || ""} ${s.memo || ""}`;
  const l1 = ctx.rules.filter(r => r.layer === 1 && ctx.ruleEnabled(r.id)).sort((a, b) => a.priority - b.priority);
  for (const r of l1) {
    if (r.strategy === "identify_payment_company") {
      const pc = ctx.paymentCompanies.find(p => p.aliases.some(a => text.includes(a)));
      if (pc) return { status: "IDENTIFIED", sourceType: "支付公司清算款", paymentCompanyId: pc.id, ruleId: r.id, ruleVersion: r.version, evidence: `付款户名/摘要命中${pc.name}别名` };
    }
    if (r.strategy === "identify_nonbusiness" && (r.params?.keywords ?? []).some((k: string) => text.includes(k))) {
      const hits = (r.params?.keywords ?? []).filter((k: string) => text.includes(k)).join("、");
      return { status: "IDENTIFIED", sourceType: "非业务入账", paymentCompanyId: "", ruleId: r.id, ruleVersion: r.version, evidence: `摘要命中：${hits}` };
    }
    if (r.strategy === "identify_transfer") {
      const orderRef = /[A-Z]{2,}[-_][A-Z0-9-]+/i.test(s.memo || "");
      const keyword = (r.params?.keywords ?? []).find((k: string) => (s.memo || "").includes(k));
      if (orderRef || keyword) {
        return { status: "IDENTIFIED", sourceType: "银行转账", paymentCompanyId: "", ruleId: r.id, ruleVersion: r.version, evidence: orderRef ? "摘要含企业订单号格式" : `摘要命中明确转账用途关键词：${keyword}` };
      }
    }
  }
  return { status: "UNIDENTIFIED", sourceType: "", paymentCompanyId: "", ruleId: "", ruleVersion: 0, evidence: "已执行有效识别规则，但付款方与摘要均未达到安全分类条件" };
}

/** 版本化写入：签名不变则复用；签名变化则旧版本 current=0，追加新版本 */
function versionedIdentity(ctx: WorkContext, statementId: string, payload: IdentifyOutcome, evaluationId: string): MoneyIdentity {
  const prev = ctx.identities.get(statementId);
  const signature = JSON.stringify(payload);
  if (prev && prev.signature === signature) return prev;
  if (prev) {
    ctx.db.prepare(`UPDATE money_identities SET current=0 WHERE id=?`).run(prev.id);
  }
  const id = ctx.idGen.next("MI");
  const version = (prev?.version ?? 0) + 1;
  const rec: MoneyIdentity = { id, statementId, version, signature, ...payload, decidedAt: nowText() };
  ctx.db.prepare(`INSERT INTO money_identities(id,evaluation_id,statement_id,version,current,signature,status,source_type,payment_company_id,rule_id,rule_version,evidence,decided_at)
    VALUES(?,?,?,?,1,?,?,?,?,?,?,?,?)`)
    .run(id, evaluationId, statementId, version, signature, payload.status, payload.sourceType, payload.paymentCompanyId, payload.ruleId, payload.ruleVersion, payload.evidence, rec.decidedAt);
  if (payload.ruleId) ctx.hitRule(payload.ruleId, payload.ruleVersion);
  ctx.identities.set(statementId, rec);
  ctx.audit("资金识别", statementId, `${statementId} 身份版本 V${version}：${payload.status === "IDENTIFIED" ? payload.sourceType : "未识别"}。`, payload.evidence);
  return rec;
}

/* ================= 认领组 ================= */

function groupRelation(sps: StatementPart[], tps: TargetPart[]): MatchGroup["relationType"] {
  const s = new Set(sps.map(e => e.statementId)).size;
  const o = new Set(tps.map(e => e.targetId)).size;
  return s === 1 && o === 1 ? "1:1" : s === 1 ? "1:N" : o === 1 ? "N:1" : "N:N";
}

export function validateGroup(ctx: WorkContext, sps: StatementPart[], tps: TargetPart[]): string {
  const sTotal = sps.reduce((a, p) => a + p.amountCents, 0);
  const tTotal = tps.reduce((a, p) => a + p.amountCents, 0);
  if (!sTotal || sTotal !== tTotal) return "资金组两侧金额必须相等";
  for (const p of sps) if (p.amountCents > ctx.statementAvailable(p.statementId)) return `流水 ${p.statementId} 可认领余额不足`;
  for (const p of tps) if (p.amountCents > ctx.orderAvailable(p.targetId)) return `订单 ${p.targetId} 可勾兑余额不足`;
  return "";
}

export function createMatchGroup(ctx: WorkContext, opts: {
  origin: "AUTO" | "MANUAL"; ruleId?: string; statementParts: StatementPart[]; targetParts: TargetPart[];
  note?: string; edgeMode?: "DIRECT" | "GROUP_TOTAL";
}): { groupId?: string; error?: string } {
  const err = validateGroup(ctx, opts.statementParts, opts.targetParts);
  if (err) return { error: err };
  const id = ctx.idGen.next("MG");
  const relation = groupRelation(opts.statementParts, opts.targetParts);
  const r = opts.ruleId ? ctx.rule(opts.ruleId) : undefined;
  ctx.db.prepare(`INSERT INTO match_groups(id,status,origin,rule_id,rule_version,relation_type,edge_mode,note,created_at,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, "CONFIRMED", opts.origin, opts.ruleId ?? "", r?.version ?? 0, relation, opts.edgeMode ?? "DIRECT", opts.note ?? "", nowText(), opts.origin === "AUTO" ? "规则引擎" : ctx.actor);
  for (const p of opts.statementParts) {
    ctx.db.prepare(`INSERT INTO statement_parts(id,group_id,statement_id,amount_cents) VALUES(?,?,?,?)`)
      .run(ctx.idGen.next("SP"), id, p.statementId, p.amountCents);
  }
  for (const p of opts.targetParts) {
    ctx.db.prepare(`INSERT INTO target_parts(id,group_id,target_type,target_id,amount_cents) VALUES(?,?,?,?,?)`)
      .run(ctx.idGen.next("TP"), id, p.targetType, p.targetId, p.amountCents);
  }
  const group: MatchGroup = {
    id, status: "CONFIRMED", origin: opts.origin, ruleId: opts.ruleId ?? "", ruleVersion: r?.version ?? 0,
    relationType: relation, edgeMode: opts.edgeMode ?? "DIRECT", note: opts.note ?? "",
    createdAt: nowText(), createdBy: opts.origin === "AUTO" ? "规则引擎" : ctx.actor,
    statementParts: opts.statementParts, targetParts: opts.targetParts,
  };
  ctx.groups.push(group);
  if (r) ctx.hitRule(r.id, r.version);
  ctx.audit(opts.origin === "AUTO" ? "自动认领" : "人工认领", id,
    `${relation}认领组已确认。`,
    `${opts.ruleId ? `${opts.ruleId} V${r?.version}` : "人工确认"}；${(opts.edgeMode ?? "DIRECT") === "GROUP_TOTAL" ? "按组总额确认，不伪造逐笔对应" : "直接关系"}；${opts.note ?? ""}`);
  return { groupId: id };
}

/* ================= 第二层：自动认领规则 ================= */

interface PayGroupCtx {
  key: string; pcId: string; items: Statement[]; dates: string[];
  orders: OrderSnapshot[]; targetParts: TargetPart[] | null; actualCents: number; expectedCents: number;
}

export function paymentStatementGroups(ctx: WorkContext, targetIds: Set<string>): PayGroupCtx[] {
  const groups = new Map<string, Statement[]>();
  for (const s of ctx.statements) {
    const identity = ctx.identities.get(s.id);
    if (identity?.sourceType !== "支付公司清算款" || ctx.statementAvailable(s.id) <= 0) continue;
    const key = `${identity.paymentCompanyId}|${s.settlementGroupKey || s.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.some(s => targetIds.has(s.id)))
    .map(([key, items]) => {
      const pcId = key.split("|")[0];
      const dates = [...new Set(items.flatMap(s => settlementBusinessDates(s.bookingDate)))].sort();
      const orders = ctx.orders
        .filter(o => o.paymentStatus === "支付成功" && o.paymentCompanyId === pcId && dates.includes(o.paymentSuccessDate) && ctx.orderAvailable(o.id) > 0)
        .sort((a, b) => a.paymentSuccessDate.localeCompare(b.paymentSuccessDate) || a.orderNo.localeCompare(b.orderNo));
      const pc = ctx.paymentCompany(pcId);
      const targetParts = ctx.orderExpectedParts(orders, pc);
      return {
        key, pcId, items, dates, orders, targetParts,
        actualCents: items.reduce((sum, s) => sum + ctx.statementAvailable(s.id), 0),
        expectedCents: targetParts?.reduce((sum, p) => sum + p.amountCents, 0) ?? 0,
      };
    });
}

/** 子集和搜索（V2 findSubset 同款：items 限 16、组合深度限制、容差） */
export function findSubset<T>(items: T[], target: number, valueFn: (x: T) => number, maxSize = 8, minSize = 1, tolerance = 0): T[] | null {
  const arr = items.slice(0, 16);
  let answer: T[] | null = null;
  const walk = (start: number, picked: T[], total: number) => {
    if (answer || total > target + tolerance) return;
    if (Math.abs(total - target) <= tolerance && picked.length >= minSize) { answer = picked.slice(); return; }
    if (picked.length >= maxSize) return;
    for (let i = start; i < arr.length; i++) {
      picked.push(arr[i]);
      walk(i + 1, picked, total + valueFn(arr[i]));
      picked.pop();
      if (answer) return;
    }
  };
  walk(0, [], 0);
  return answer;
}

export function allocatePaymentCompanies(ctx: WorkContext, targetIds: Set<string>): void {
  if (!ctx.ruleEnabled("L2-001")) return;
  const r = ctx.rule("L2-001")!;
  for (const g of paymentStatementGroups(ctx, targetIds)) {
    if (!g.orders.length || !g.targetParts) continue;
    const pc = ctx.paymentCompany(g.pcId)!;
    if (Math.abs(g.actualCents - g.expectedCents) <= (r.params?.toleranceCents ?? 0)) {
      createMatchGroup(ctx, {
        origin: "AUTO", ruleId: r.id,
        statementParts: g.items.map(s => ({ statementId: s.id, amountCents: ctx.statementAvailable(s.id) })),
        targetParts: g.targetParts,
        note: `${pc.name}｜业务日 ${g.dates.join("、")}｜成功订单${g.orders.length}笔｜手续费版本V${pc.version}`,
        edgeMode: g.items.length > 1 && g.orders.length > 1 ? "GROUP_TOTAL" : "DIRECT",
      });
    }
  }
}

function allocateTransferReference(ctx: WorkContext, targetIds: Set<string>): void {
  if (!ctx.ruleEnabled("L2-002")) return;
  const r = ctx.rule("L2-002")!;
  for (const order of ctx.pendingTransferOrders()) {
    const candidates = ctx.availableTransferStatements().filter(s => (s.memo || "").includes(order.orderNo));
    if (!candidates.some(s => targetIds.has(s.id))) continue;
    const total = candidates.reduce((sum, s) => sum + ctx.statementAvailable(s.id), 0);
    if (Math.abs(total - ctx.orderAvailable(order.id)) <= (r.params?.toleranceCents ?? 0)) {
      const result = createMatchGroup(ctx, {
        origin: "AUTO", ruleId: r.id,
        statementParts: candidates.map(s => ({ statementId: s.id, amountCents: ctx.statementAvailable(s.id) })),
        targetParts: [{ targetType: "BUSINESS_ORDER", targetId: order.id, amountCents: ctx.orderAvailable(order.id) }],
        note: `摘要明确包含订单号 ${order.orderNo}，${candidates.length}笔转账合计闭合。`,
      });
      if (!result.error) continue;
    }
  }
}

function allocateTransferCustomerSum(ctx: WorkContext, targetIds: Set<string>): void {
  if (!ctx.ruleEnabled("L2-003")) return;
  const r = ctx.rule("L2-003")!;
  for (const s of ctx.availableTransferStatements().filter(x => targetIds.has(x.id))) {
    const candidates = ctx.pendingTransferOrders().filter(o => normalize(o.customerName) === normalize(s.payerName));
    const subset = findSubset(candidates, ctx.statementAvailable(s.id), o => ctx.orderAvailable(o.id),
      r.params?.maxCombination ?? 8, 2, r.params?.toleranceCents ?? 0);
    if (subset) {
      createMatchGroup(ctx, {
        origin: "AUTO", ruleId: r.id,
        statementParts: [{ statementId: s.id, amountCents: ctx.statementAvailable(s.id) }],
        targetParts: subset.map(o => ({ targetType: "BUSINESS_ORDER", targetId: o.id, amountCents: ctx.orderAvailable(o.id) })),
        note: `付款方与订单客户一致，${subset.length}笔订单合计闭合。`,
      });
    }
  }
}

function allocateTransferPartial(ctx: WorkContext, targetIds: Set<string>): void {
  if (!ctx.ruleEnabled("L2-004")) return;
  const r = ctx.rule("L2-004")!;
  for (const s of ctx.availableTransferStatements().filter(x => targetIds.has(x.id))) {
    const candidates = ctx.pendingTransferOrders()
      .filter(o => (s.memo || "").includes(o.orderNo) && ctx.statementAvailable(s.id) < ctx.orderAvailable(o.id));
    if (candidates.length === 1) {
      createMatchGroup(ctx, {
        origin: "AUTO", ruleId: r.id,
        statementParts: [{ statementId: s.id, amountCents: ctx.statementAvailable(s.id) }],
        targetParts: [{ targetType: "BUSINESS_ORDER", targetId: candidates[0].id, amountCents: ctx.statementAvailable(s.id) }],
        note: `摘要明确包含 ${candidates[0].orderNo}，整笔流水作为订单部分付款。`,
      });
    }
  }
}

/* ================= 第二层：Allocation Decision ================= */

export function evaluateAllocationDecision(ctx: WorkContext, statement: Statement, evaluationId: string): AllocationDecision {
  const identity = ctx.identities.get(statement.id);
  const groups = ctx.activeGroups().filter(g => g.statementParts.some(p => p.statementId === statement.id));
  const manual = ctx.manualNR.get(statement.id);
  let payload: Omit<AllocationDecision, "id" | "statementId" | "version" | "signature" | "decidedAt" | "decidedBy"> & { decidedBy?: string };

  if (!identity || identity.status === "UNIDENTIFIED") {
    payload = { status: "PENDING", coverage: "NONE", targetType: "UNRESOLVED", targetIds: [], groupIds: [], ruleId: "", ruleVersion: 0, basis: "等待资金身份明确后再判断业务归属" };
  } else if (manual) {
    const type = ctx.nonReceivableTypes.find(x => x.id === manual.typeId);
    payload = { status: "CONFIRMED", coverage: "FULL", targetType: "NON_RECEIVABLE_TYPE", targetIds: [manual.typeId], groupIds: [], ruleId: "L2-005", ruleVersion: ctx.rule("L2-005")?.version ?? 0, basis: `${ctx.actor}确认无应收资金类型：${type?.name ?? manual.typeId}；凭据：${manual.evidence}`, decidedBy: ctx.actor };
  } else if (identity.sourceType === "非业务入账" && ctx.ruleEnabled("L2-005")) {
    const nrRule = ctx.rule("L2-005")!;
    const typeId = nrRule.params?.interestTypeId ?? "NRT-INTEREST";
    payload = { status: "CONFIRMED", coverage: "FULL", targetType: "NON_RECEIVABLE_TYPE", targetIds: [typeId], groupIds: [], ruleId: "L2-005", ruleVersion: nrRule.version, basis: "自动归属为银行结息；无需业务订单，但已形成受控资金归属" };
    ctx.hitRule("L2-005", nrRule.version);
  } else if (ctx.statementApplied(statement.id) === statement.amountCents) {
    const targetIds = [...new Set(groups.flatMap(g => g.targetParts.map(p => p.targetId)))];
    payload = {
      status: "CONFIRMED", coverage: "FULL", targetType: "BUSINESS_ORDER", targetIds, groupIds: groups.map(g => g.id),
      ruleId: groups.map(g => g.ruleId).filter(Boolean).join("、"),
      ruleVersion: Math.max(0, ...groups.map(g => g.ruleVersion || 0)),
      basis: groups.map(g => `${g.relationType} ${g.id}：${g.note}`).join("；"),
    };
  } else if (ctx.statementApplied(statement.id) > 0) {
    payload = { status: "NEED_REVIEW", coverage: "PARTIAL", targetType: "BUSINESS_ORDER", targetIds: [], groupIds: groups.map(g => g.id), ruleId: "", ruleVersion: 0, basis: `仍有 ${(ctx.statementAvailable(statement.id) / 100).toFixed(2)} 元未归属` };
  } else {
    payload = { status: "NEED_REVIEW", coverage: "NONE", targetType: "UNRESOLVED", targetIds: [], groupIds: [], ruleId: "", ruleVersion: 0, basis: "已完成身份识别，但尚未形成可确认的业务订单或无应收资金归属" };
  }

  const signature = JSON.stringify({ status: payload.status, coverage: payload.coverage, targetType: payload.targetType, targetIds: payload.targetIds, groupIds: payload.groupIds, ruleId: payload.ruleId, ruleVersion: payload.ruleVersion, basis: payload.basis });
  const prev = ctx.decisions.get(statement.id);
  if (prev && prev.signature === signature) return prev;
  if (prev) ctx.db.prepare(`UPDATE allocation_decisions SET current=0 WHERE id=?`).run(prev.id);
  const id = ctx.idGen.next("AD");
  const version = (prev?.version ?? 0) + 1;
  const rec: AllocationDecision = {
    id, statementId: statement.id, version, signature,
    status: payload.status, coverage: payload.coverage, targetType: payload.targetType,
    targetIds: payload.targetIds, groupIds: payload.groupIds, ruleId: payload.ruleId, ruleVersion: payload.ruleVersion,
    basis: payload.basis, decidedAt: nowText(),
    decidedBy: payload.decidedBy ?? (payload.status === "CONFIRMED" ? "规则引擎" : "规则引擎"),
  };
  ctx.db.prepare(`INSERT INTO allocation_decisions(id,evaluation_id,statement_id,version,current,signature,status,coverage,target_type,target_ids,group_ids,rule_id,rule_version,basis,decided_at,decided_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, evaluationId, statement.id, version, 1, signature, rec.status, rec.coverage, rec.targetType, jstr(rec.targetIds), jstr(rec.groupIds), rec.ruleId, rec.ruleVersion, rec.basis, rec.decidedAt, rec.decidedBy);
  ctx.decisions.set(statement.id, rec);
  ctx.audit("认领决策", statement.id, `${statement.id} 认领决策 V${version}：${rec.status}/${rec.coverage}。`, rec.basis);
  return rec;
}

/* ================= 第三层：异常事件 ================= */

interface Trigger {
  ruleId: string; type: string; statementIds: string[]; orderIds: string[];
  actualCents: number; expectedCents: number; location: string; responsibility: string;
  basis: string; route: string; severity: "高" | "中" | "低";
}

function makeTrigger(ctx: WorkContext, t: Omit<Trigger, "orderIds" | "actualCents" | "expectedCents"> & Partial<Pick<Trigger, "orderIds" | "actualCents" | "expectedCents">>): Trigger {
  return { orderIds: [], actualCents: 0, expectedCents: 0, ...t };
}

export function transferCandidateScores(ctx: WorkContext, s: Statement) {
  return ctx.pendingTransferOrders().map(o => {
    let score = 0; const reasons: string[] = [];
    if ((s.memo || "").includes(o.orderNo)) { score += 60; reasons.push("订单号"); }
    if (normalize(s.payerName) === normalize(o.customerName)) { score += 25; reasons.push("付款方"); }
    if (ctx.statementAvailable(s.id) === ctx.orderAvailable(o.id)) { score += 20; reasons.push("金额"); }
    return { o, score, reasons };
  }).filter(x => x.score >= 20).sort((a, b) => b.score - a.score);
}

export function collectExceptionTriggers(ctx: WorkContext, targetIds: Set<string>): Trigger[] {
  const triggers: Trigger[] = [];
  // 资金来源未识别
  for (const id of targetIds) {
    const s = ctx.statements.find(x => x.id === id);
    const identity = ctx.identities.get(id);
    if (!s || !identity) continue;
    if (identity.status === "UNIDENTIFIED" && ctx.ruleEnabled("L3-005")) {
      const r = ctx.rule("L3-005")!;
      triggers.push(makeTrigger(ctx, {
        ruleId: "L3-005", type: "资金来源未识别", statementIds: [id], actualCents: s.amountCents,
        location: "第一层资金识别", responsibility: "资金规则管理员", basis: identity.evidence,
        route: r.params?.route ?? "补充第一层识别规则或人工确认来源", severity: r.params?.severity ?? "高",
      }));
    }
  }
  // 支付公司组差异 / 无订单 / 手续费缺失
  for (const g of paymentStatementGroups(ctx, targetIds)) {
    const unresolved = g.items.filter(s => ctx.decisions.get(s.id)?.coverage !== "FULL");
    if (!unresolved.length) continue;
    const statementIds = unresolved.map(s => s.id);
    const actual = unresolved.reduce((sum, s) => sum + ctx.statementAvailable(s.id), 0);
    const pc = ctx.paymentCompany(g.pcId);
    if (!pc || !pc.enabled) {
      const r = ctx.rule("L3-007");
      if (r && ctx.ruleEnabled("L3-007")) triggers.push(makeTrigger(ctx, {
        ruleId: "L3-007", type: "手续费规则缺失", statementIds, actualCents: actual,
        location: "第二层资金认领", responsibility: "资金规则管理员",
        basis: `${pc?.name ?? g.pcId} 无有效手续费版本`, route: r.params?.route ?? "维护支付公司手续费预设", severity: r.params?.severity ?? "高",
      }));
    } else if (!g.orders.length) {
      const r = ctx.rule("L3-002");
      if (r && ctx.ruleEnabled("L3-002")) triggers.push(makeTrigger(ctx, {
        ruleId: "L3-002", type: "支付公司业务归属待确认", statementIds, actualCents: actual,
        location: "第二层资金认领", responsibility: "业务系统/客户财务",
        basis: `${pc.name}候选业务日${g.dates.join("、")}没有成功订单，且尚未确认合法无应收资金类型`,
        route: r.params?.route ?? "补同步订单或转无应收资金归属", severity: r.params?.severity ?? "高",
      }));
    } else {
      const r = ctx.rule("L3-001");
      const tol = ctx.rule("L2-001")?.params?.toleranceCents ?? 0;
      if (r && ctx.ruleEnabled("L3-001") && Math.abs(g.actualCents - g.expectedCents) > tol) {
        triggers.push(makeTrigger(ctx, {
          ruleId: "L3-001", type: "支付公司清算金额差异", statementIds: g.items.map(s => s.id),
          orderIds: g.orders.map(o => o.id), actualCents: g.actualCents, expectedCents: g.expectedCents,
          location: "第二层资金认领", responsibility: "客户财务/业务系统",
          basis: `${pc.name}成功订单${g.orders.length}笔，扣手续费后理论金额与银行入账不一致`,
          route: r.params?.route ?? "检查手续费预设与成功订单范围", severity: r.params?.severity ?? "高",
        }));
      }
    }
  }
  // 银行转账候选
  for (const id of targetIds) {
    const s = ctx.statements.find(x => x.id === id);
    const identity = ctx.identities.get(id);
    const decision = ctx.decisions.get(id);
    if (!s || identity?.sourceType !== "银行转账" || decision?.coverage === "FULL") continue;
    const candidates = transferCandidateScores(ctx, s);
    const r3 = ctx.rule("L3-003");
    const r4 = ctx.rule("L3-004");
    if (candidates.length > 1 && r3 && ctx.ruleEnabled("L3-003")) {
      triggers.push(makeTrigger(ctx, {
        ruleId: "L3-003", type: "银行转账多候选", statementIds: [id], orderIds: candidates.map(x => x.o.id),
        actualCents: ctx.statementAvailable(id), expectedCents: ctx.statementAvailable(id),
        location: "第二层资金认领", responsibility: "客户财务",
        basis: candidates.map(x => `${x.o.orderNo}:${x.reasons.join("+")}`).join("；"),
        route: r3.params?.route ?? "转第二层人工认领", severity: r3.params?.severity ?? "中",
      }));
    } else if (!candidates.length && r4 && ctx.ruleEnabled("L3-004")) {
      triggers.push(makeTrigger(ctx, {
        ruleId: "L3-004", type: "银行转账无候选", statementIds: [id], actualCents: ctx.statementAvailable(id),
        location: "第二层资金认领", responsibility: "业务系统/客户财务",
        basis: "待确定订单候选池未找到可解释对象",
        route: r4.params?.route ?? "等待订单同步或确认无应收归属", severity: r4.params?.severity ?? "中",
      }));
    } else if (candidates.length === 1 && r3 && ctx.ruleEnabled("L3-003")) {
      triggers.push(makeTrigger(ctx, {
        ruleId: "L3-003", type: "银行转账候选待确认", statementIds: [id], orderIds: [candidates[0].o.id],
        actualCents: ctx.statementAvailable(id), expectedCents: ctx.statementAvailable(id),
        location: "第二层资金认领", responsibility: "客户财务",
        basis: `唯一候选 ${candidates[0].o.orderNo}：${candidates[0].reasons.join("+")}，等待人工确认`,
        route: r3.params?.route ?? "转第二层人工认领", severity: r3.params?.severity ?? "中",
      }));
    }
  }
  // 未闭环余额（部分认领不是终态）
  const r6 = ctx.rule("L3-006");
  if (r6 && ctx.ruleEnabled("L3-006")) {
    for (const id of targetIds) {
      const s = ctx.statements.find(x => x.id === id);
      const identity = ctx.identities.get(id);
      const decision = ctx.decisions.get(id);
      if (!s || !identity || identity.status === "UNIDENTIFIED") continue;
      if (decision?.coverage !== "PARTIAL") continue;
      triggers.push(makeTrigger(ctx, {
        ruleId: "L3-006", type: "流水未完成认领", statementIds: [id], actualCents: s.amountCents,
        location: "第二层资金认领", responsibility: "客户财务",
        basis: `完整评估后仍有 ${(ctx.statementAvailable(id) / 100).toFixed(2)} 元未归属余额`,
        route: r6.params?.route ?? "转第二层补充认领决策", severity: r6.params?.severity ?? "高",
      }));
    }
  }
  return triggers;
}

/** 稳定异常事件同步：同 fingerprint 更新/复用；阻塞解除时以新证据关闭 */
export function syncExceptionEvents(ctx: WorkContext, targetIds: Set<string>, evaluationId: string): { detectedNew: ExceptionEvent[]; closed: ExceptionEvent[] } {
  const triggers = collectExceptionTriggers(ctx, targetIds);
  const detectedNew: ExceptionEvent[] = [];
  const closed: ExceptionEvent[] = [];
  const byFp = new Map(ctx.exceptions.map(e => [e.fingerprint, e]));

  for (const t of triggers) {
    const fingerprint = `${t.ruleId}|${t.type}|${[...t.statementIds].sort().join(",")}`;
    const existing = byFp.get(fingerprint);
    if (existing) {
      if (existing.status === "CLOSED") {
        // 问题复发：重开同一事件的新版本
        reopenException(ctx, existing, t, evaluationId);
        detectedNew.push(existing);
      } else if (existing.basis !== t.basis || existing.ruleVersion !== ctx.rule(t.ruleId)?.version) {
        // 诊断依据或规则版本变化：追加版本，保持状态
        appendExceptionVersion(ctx, existing, t);
      }
      continue;
    }
    const ev = insertException(ctx, t, fingerprint, evaluationId);
    ctx.exceptions.push(ev);
    detectedNew.push(ev);
    ctx.audit("异常发现", ev.id, `${ev.type}：${ev.basis}`, `定位：${ev.location}｜责任域：${ev.responsibility}｜路径：${ev.route}`);
  }

  // 阻塞解除检查：开放事件不再触发且对应资金已完成归属/身份已识别 → 以新证据关闭
  for (const ev of ctx.exceptions.filter(e => e.status !== "CLOSED")) {
    if (triggers.some(t => `${t.ruleId}|${t.type}|${[...t.statementIds].sort().join(",")}` === ev.fingerprint)) continue;
    if (!ev.statementIds.some(id => targetIds.has(id))) continue;
    const resolved = ev.statementIds.every(id => {
      const d = ctx.decisions.get(id);
      const i = ctx.identities.get(id);
      if (ev.ruleId === "L3-005") return i?.status === "IDENTIFIED";
      return d?.status === "CONFIRMED" && d?.coverage === "FULL";
    });
    if (!resolved) continue;
    closeExceptionInternal(ctx, ev, "阻塞条件已解除", `评估批次 ${evaluationId}：相关资金已完成受控归属或身份已识别，依据当前有效版本关闭`, evaluationId);
    closed.push(ev);
  }
  return { detectedNew, closed };
}

function insertException(ctx: WorkContext, t: Trigger, fingerprint: string, evaluationId: string): ExceptionEvent {
  const id = ctx.idGen.next("EXC");
  const ev: ExceptionEvent = {
    id, fingerprint, type: t.type, ruleId: t.ruleId, ruleVersion: ctx.rule(t.ruleId)?.version ?? 0,
    statementIds: [...t.statementIds].sort(), orderIds: t.orderIds,
    actualCents: t.actualCents, expectedCents: t.expectedCents, differenceCents: t.actualCents - t.expectedCents,
    location: t.location, responsibility: t.responsibility, basis: t.basis, route: t.route, severity: t.severity,
    blocking: true, status: "DETECTED", version: 1, detectedAt: nowText(), history: [],
  };
  ctx.db.prepare(`INSERT INTO exception_events(id,fingerprint,type,rule_id,rule_version,statement_ids,order_ids,actual_cents,expected_cents,difference_cents,location,responsibility,basis,route,severity,blocking,status,version,detected_at,history)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ev.id, fingerprint, ev.type, ev.ruleId, ev.ruleVersion, jstr(ev.statementIds), jstr(ev.orderIds),
      ev.actualCents, ev.expectedCents, ev.differenceCents, ev.location, ev.responsibility, ev.basis,
      ev.route, ev.severity, 1, ev.status, 1, ev.detectedAt, jstr(ev.history));
  void evaluationId;
  return ev;
}

function appendExceptionVersion(ctx: WorkContext, ev: ExceptionEvent, t: Trigger): void {
  ev.history.push({ version: ev.version, status: ev.status, basis: ev.basis, changedAt: nowText() });
  ev.version += 1;
  ev.basis = t.basis; ev.route = t.route; ev.severity = t.severity; ev.location = t.location; ev.responsibility = t.responsibility;
  ev.ruleVersion = ctx.rule(t.ruleId)?.version ?? ev.ruleVersion;
  ev.actualCents = t.actualCents; ev.expectedCents = t.expectedCents; ev.differenceCents = t.actualCents - t.expectedCents;
  persistException(ctx, ev);
  ctx.audit("异常更新", ev.id, `${ev.type} 诊断依据更新至 V${ev.version}。`, ev.basis);
}

function reopenException(ctx: WorkContext, ev: ExceptionEvent, t: Trigger, evaluationId: string): void {
  ev.history.push({ version: ev.version, status: ev.status, basis: ev.basis, changedAt: nowText(), actor: `评估批次 ${evaluationId}` });
  ev.version += 1;
  ev.status = "DETECTED"; ev.detectedAt = nowText();
  ev.closedAt = undefined; ev.closedReason = undefined; ev.closeEvidence = undefined;
  ev.basis = `${t.basis}（关闭后问题复发，重新打开）`;
  persistException(ctx, ev);
  ctx.audit("异常重开", ev.id, `${ev.type} 在关闭后再次触发，重开为 V${ev.version}。`, t.basis);
}

function closeExceptionInternal(ctx: WorkContext, ev: ExceptionEvent, reason: string, evidence: string, evaluationId: string): void {
  ev.history.push({ version: ev.version, status: ev.status, basis: ev.basis, changedAt: nowText(), actor: `评估批次 ${evaluationId}` });
  ev.version += 1;
  ev.status = "CLOSED"; ev.closedAt = nowText(); ev.closedReason = reason; ev.closeEvidence = evidence;
  persistException(ctx, ev);
  ctx.audit("异常关闭", ev.id, `${ev.type} 已关闭。`, `${reason}｜${evidence}`);
}

export function persistException(ctx: WorkContext, ev: ExceptionEvent): void {
  ctx.db.prepare(`UPDATE exception_events SET status=?, version=?, processing_at=?, closed_at=?, closed_reason=?, close_evidence=?, basis=?, route=?, severity=?, location=?, responsibility=?, rule_version=?, actual_cents=?, expected_cents=?, difference_cents=?, history=?
    WHERE id=?`)
    .run(ev.status, ev.version, ev.processingAt ?? null, ev.closedAt ?? null, ev.closedReason ?? null,
      ev.closeEvidence ?? null, ev.basis, ev.route, ev.severity, ev.location, ev.responsibility,
      ev.ruleVersion, ev.actualCents, ev.expectedCents, ev.differenceCents, jstr(ev.history), ev.id);
}

/* ================= 第四层：可信资金状态 ================= */

export function evaluateTrustedStatus(ctx: WorkContext, statement: Statement, evaluationId: string): TrustedStatus {
  const identity = ctx.identities.get(statement.id);
  const decision = ctx.decisions.get(statement.id);
  const openExcs = ctx.openExceptionsForStatement(statement.id).filter(e => e.blocking);
  const openIds = openExcs.map(e => e.id);
  let status: TrustedStatus["status"];
  let basis: string;
  if (openExcs.length) {
    status = "Blocked";
    basis = `存在 ${openExcs.length} 项未关闭阻塞异常：${openExcs.map(e => e.type).join("、")}`;
  } else if (identity?.status === "IDENTIFIED" && decision?.status === "CONFIRMED" && decision.coverage === "FULL") {
    status = "Closed";
    basis = decision.targetType === "NON_RECEIVABLE_TYPE"
      ? `资金已识别且完成无应收资金归属（${decision.targetIds.join("、")}）`
      : `资金已识别且完成全部业务订单归属`;
  } else {
    status = "Processing";
    basis = !identity || identity.status === "UNIDENTIFIED"
      ? "等待资金识别或规则覆盖"
      : "正常作业未完成：等待认领决策或异常处理";
  }
  const signature = JSON.stringify({ status, identityId: identity?.id, identityVersion: identity?.version, allocationDecisionId: decision?.id, allocationDecisionVersion: decision?.version, openExceptionIds: openIds, policyId: ctx.closurePolicy.id, policyVersion: ctx.closurePolicy.version, basis });
  const prev = ctx.trusted.get(statement.id);
  if (prev && prev.signature === signature) return prev;
  if (prev) ctx.db.prepare(`UPDATE trusted_statuses SET current=0 WHERE id=?`).run(prev.id);
  const id = ctx.idGen.next("TMS");
  const version = (prev?.version ?? 0) + 1;
  const rec: TrustedStatus = {
    id, statementId: statement.id, version, signature, status,
    identityId: identity?.id, identityVersion: identity?.version,
    allocationDecisionId: decision?.id, allocationDecisionVersion: decision?.version,
    openExceptionIds: openIds, policyId: ctx.closurePolicy.id, policyVersion: ctx.closurePolicy.version,
    basis, evaluatedAt: nowText(),
  };
  ctx.db.prepare(`INSERT INTO trusted_statuses(id,evaluation_id,statement_id,version,current,signature,status,identity_id,identity_version,allocation_decision_id,allocation_decision_version,open_exception_ids,policy_id,policy_version,basis,evaluated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, evaluationId, statement.id, version, 1, signature, status, identity?.id ?? null, identity?.version ?? null,
      decision?.id ?? null, decision?.version ?? null, jstr(openIds), ctx.closurePolicy.id, ctx.closurePolicy.version, basis, rec.evaluatedAt);
  if (prev) ctx.changedStatementIds.add(statement.id);
  ctx.trusted.set(statement.id, rec);
  return rec;
}

/* ================= 编排：运行四层评估 ================= */

export interface RunResult {
  evaluationId: string;
  statementCount: number;
  identities: number; decisions: number; exceptionsNew: number; exceptionsClosed: number; trustedChanges: number;
}

export function runFourLayers(ctx: WorkContext, opts: { source?: string; statementIds?: string[] } = {}): RunResult {
  const source = opts.source ?? "manual";
  const ids = opts.statementIds?.length
    ? opts.statementIds.filter(id => ctx.statements.some(s => s.id === id))
    : ctx.statements.map(s => s.id);
  const targetIds = new Set(ids);

  const evaluationId = ctx.idGen.next("EVAL");
  ctx.db.prepare(`INSERT INTO evaluations(id,account_id,recon_date,source,statement_ids,started_at) VALUES(?,?,?,?,?,?)`)
    .run(evaluationId, ctx.accountId, ctx.reconDate, source, jstr(ids), nowText());

  // ① 识别（只评估目标流水；非目标流水身份已在上下文）
  for (const id of ids) {
    const s = ctx.statements.find(x => x.id === id);
    if (!s) continue;
    versionedIdentity(ctx, id, identityResult(ctx, s), evaluationId);
  }
  // ② 自动认领（支付公司汇总 → 订单号 → 客户汇总 → 部分付款）
  allocatePaymentCompanies(ctx, targetIds);
  allocateTransferReference(ctx, targetIds);
  allocateTransferCustomerSum(ctx, targetIds);
  allocateTransferPartial(ctx, targetIds);
  // ② 认领决策
  for (const id of ids) {
    const s = ctx.statements.find(x => x.id === id);
    if (s) evaluateAllocationDecision(ctx, s, evaluationId);
  }
  // ③ 异常事件同步
  const exc = syncExceptionEvents(ctx, targetIds, evaluationId);
  // ④ 可信资金状态
  for (const id of ids) {
    const s = ctx.statements.find(x => x.id === id);
    if (s) evaluateTrustedStatus(ctx, s, evaluationId);
  }
  ctx.flushRuleHits();

  const stats = {
    statements: ids.length,
    identitiesNew: ctx.statements.filter(s => targetIds.has(s.id) && ctx.identities.get(s.id)?.id.startsWith("MI")).length,
    exceptionsNew: exc.detectedNew.length,
    exceptionsClosed: exc.closed.length,
  };
  ctx.db.prepare(`UPDATE evaluations SET finished_at=?, stats=? WHERE id=?`)
    .run(nowText(), JSON.stringify(stats), evaluationId);
  ctx.audit("四层评估", evaluationId, `评估 ${ids.length} 笔流水（${source}）。`,
    `新增异常 ${exc.detectedNew.length}｜关闭异常 ${exc.closed.length}｜状态变化 ${ctx.changedStatementIds.size}`);
  void jparse; // 保持 import 一致性
  return {
    evaluationId, statementCount: ids.length,
    identities: ctx.statements.filter(s => targetIds.has(s.id) && ctx.identities.get(s.id)).length,
    decisions: ctx.statements.filter(s => targetIds.has(s.id) && ctx.decisions.get(s.id)).length,
    exceptionsNew: exc.detectedNew.length, exceptionsClosed: exc.closed.length,
    trustedChanges: ctx.changedStatementIds.size,
  };
}
