import type { WorkContext } from "./context.js";
import { createMatchGroup, runFourLayers, persistException } from "./engine.js";
import { jstr, nowText } from "./db.js";
import type { TargetPart } from "./types.js";

/** 第二层人工认领：关联业务订单（可拆分多订单）或确认无应收资金类型（二选一） */
export function manualAllocate(ctx: WorkContext, statementId: string, opts: {
  orderAllocations?: Array<{ orderId: string; amountCents: number }>;
  nonReceivableTypeId?: string;
  evidence?: string;
  note?: string;
}): { ok: boolean; error?: string; result?: ReturnType<typeof runFourLayers> } {
  const s = ctx.statements.find(x => x.id === statementId);
  if (!s) return { ok: false, error: `流水 ${statementId} 不存在` };
  const identity = ctx.identities.get(statementId);
  if (!identity || identity.status === "UNIDENTIFIED") return { ok: false, error: "资金身份尚未明确，不能直接进入第二层归属" };
  if (ctx.decisions.get(statementId)?.coverage === "FULL") return { ok: false, error: "该流水已经完成全部归属" };

  const allocations = (opts.orderAllocations ?? []).filter(a => a.amountCents > 0);
  const typeId: string = opts.nonReceivableTypeId ?? "";
  if (typeId && allocations.length) return { ok: false, error: "业务订单与无应收类型必须二选一" };
  if (!typeId && !allocations.length) return { ok: false, error: "请选择业务订单或无应收资金类型" };

  const note: string = opts.note?.trim() || "人工确认资金归属";

  if (allocations.length) {
    const total = allocations.reduce((sum, a) => sum + a.amountCents, 0);
    const available = ctx.statementAvailable(statementId);
    if (total > available) return { ok: false, error: `本次认领总额超过流水可认领余额 ${available} 分` };
    const targetParts: TargetPart[] = allocations.map(a => ({ targetType: "BUSINESS_ORDER", targetId: a.orderId, amountCents: a.amountCents }));
    for (const p of targetParts) {
      if (p.amountCents > ctx.orderAvailable(p.targetId)) return { ok: false, error: `订单 ${p.targetId} 可勾兑余额不足` };
    }
    const result = createMatchGroup(ctx, {
      origin: "MANUAL",
      statementParts: [{ statementId, amountCents: total }],
      targetParts, note,
    });
    if (result.error) return { ok: false, error: result.error };
  } else {
    const type = ctx.nonReceivableTypes.find(x => x.id === typeId);
    if (!type || !type.enabled) return { ok: false, error: `无应收资金类型 ${typeId} 不存在或未启用` };
    if (ctx.statementApplied(statementId) > 0) return { ok: false, error: "已有订单认领时不能直接改为整笔无应收归属" };
    const evidence = (opts.evidence ?? "").trim();
    if (type.evidenceRequired && !evidence) return { ok: false, error: "该资金类型必须填写外部确认凭据" };
    ctx.db.prepare(`INSERT INTO manual_nr_assignments(id,statement_id,type_id,amount_cents,status,evidence,note,confirmed_at,confirmed_by)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(ctx.idGen.next("NRA"), statementId, typeId, s.amountCents, "CONFIRMED", evidence || "规则证据", note, nowText(), ctx.actor);
    ctx.manualNR.set(statementId, { id: statementId, typeId, amountCents: s.amountCents, evidence: evidence || "规则证据", confirmedBy: ctx.actor });
    ctx.hitRule("L2-005", ctx.rule("L2-005")?.version ?? 1);
    ctx.flushRuleHits();
    ctx.audit("无应收资金归属", statementId, `${type.name} 已确认。`, `凭据：${evidence || "规则证据"}；银行入账不等于收入确认`);
  }

  const result = runFourLayers(ctx, { source: "第二层人工决策", statementIds: [statementId] });
  return { ok: true, result };
}

/** 第三层异常受理 */
export function acceptException(ctx: WorkContext, exceptionId: string): { ok: boolean; error?: string } {
  const ev = ctx.exceptions.find(e => e.id === exceptionId);
  if (!ev || ev.status === "CLOSED") return { ok: false, error: `异常 ${exceptionId} 不存在或已关闭` };
  if (ev.status === "PROCESSING") return { ok: false, error: "异常已处于处理中" };
  ev.history.push({ version: ev.version, status: ev.status, basis: ev.basis, changedAt: nowText(), actor: ctx.actor });
  ev.version += 1;
  ev.status = "PROCESSING";
  ev.processingAt = nowText();
  persistException(ctx, ev);
  ctx.audit("异常处理", exceptionId, "异常进入处理中。", `责任域：${ev.responsibility}；处理路径：${ev.route}`);
  return { ok: true };
}

/** 第三层异常关闭（需明确关闭依据；不自动修复数据） */
export function closeException(ctx: WorkContext, exceptionId: string, reason: string, evidence: string): { ok: boolean; error?: string } {
  const ev = ctx.exceptions.find(e => e.id === exceptionId);
  if (!ev || ev.status === "CLOSED") return { ok: false, error: `异常 ${exceptionId} 不存在或已关闭` };
  if (!reason.trim()) return { ok: false, error: "必须提供关闭原因" };
  ev.history.push({ version: ev.version, status: ev.status, basis: ev.basis, changedAt: nowText(), actor: ctx.actor });
  ev.version += 1;
  ev.status = "CLOSED";
  ev.closedAt = nowText();
  ev.closedReason = reason.trim();
  ev.closeEvidence = evidence?.trim() || "人工关闭";
  persistException(ctx, ev);
  // 关闭后重评估受影响流水的可信状态（依据 = 关闭记录）
  const run = runFourLayers(ctx, { source: "异常关闭", statementIds: ev.statementIds });
  ctx.audit("异常关闭", exceptionId, `${ev.type} 已人工关闭。`, `${ev.closedReason}｜${ev.closeEvidence}｜重评估批次 ${run.evaluationId}`);
  return { ok: true };
}

void jstr;
