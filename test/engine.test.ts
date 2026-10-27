import { test } from "node:test";
import assert from "node:assert/strict";
import { AppService } from "../src/core/service.js";

test("鲜花场景：四层结果与 V2 基线一致（10 Closed / 3 Blocked）", () => {
  const svc = AppService.open(":memory:", "test");
  const { accountId, reconDate } = svc.seedScene("flower");
  const summary = svc.summary(accountId, reconDate);
  assert.equal(summary.byStatus.Closed?.count, 10);
  assert.equal(summary.byStatus.Blocked?.count, 3);
  assert.equal(summary.statements, 13);
});

test("鲜花场景：支付公司汇总认领与金额闭合", () => {
  const svc = AppService.open(":memory:", "test");
  svc.seedScene("flower");
  const tl = svc.db.prepare(`SELECT g.relation_type, g.edge_mode FROM match_groups g WHERE g.rule_id='L2-001' AND g.note LIKE '%通联支付%'`).get() as any;
  assert.ok(tl, "通联认领组应存在");
  assert.equal(tl.relation_type, "1:N"); // 1笔流水 × 3笔订单（V2 语义）
  const cft = svc.db.prepare(`SELECT relation_type, edge_mode FROM match_groups WHERE rule_id='L2-001' AND note LIKE '%财付通%'`).get() as any;
  assert.equal(cft.relation_type, "N:N");
  assert.equal(cft.edge_mode, "GROUP_TOTAL"); // 多流水多订单，不伪造逐笔对应
});

test("鲜花场景：具体流水的可信状态", () => {
  const svc = AppService.open(":memory:", "test");
  svc.seedScene("flower");
  const statusOf = (serial: string) => (svc.db.prepare(
    `SELECT t.status, e.type AS exc_type FROM trusted_statuses t
     JOIN bank_statements s ON s.id=t.statement_id
     LEFT JOIN exception_events e ON e.id IN (SELECT value FROM json_each(t.open_exception_ids))
     WHERE s.bank_serial_no=? AND t.current=1`).get(serial) as any);
  assert.equal(statusOf("CMB-20260803-001").status, "Closed");     // 通联
  assert.equal(statusOf("CMB-20260803-002").status, "Closed");     // 财付通N:N
  assert.equal(statusOf("CMB-20260803-003").exc_type, "支付公司业务归属待确认"); // 支付宝无订单
  assert.equal(statusOf("CMB-20260803-004").status, "Closed");
  assert.equal(statusOf("CMB-20260803-005").exc_type, "支付公司清算金额差异");   // 银联差10元
  assert.equal(statusOf("CMB-20260803-006").status, "Closed");     // FL-T-007 1:1
  assert.equal(statusOf("CMB-20260803-007").status, "Closed");     // 花境 1:2 客户汇总
  assert.equal(statusOf("CMB-20260803-008").status, "Closed");     // FL-T-010 N:1（定金+尾款）
  assert.equal(statusOf("CMB-20260803-010").status, "Closed");     // FL-T-011 部分付款
  assert.equal(statusOf("CMB-20260803-011").exc_type, "资金来源未识别");         // 张伟
  assert.equal(statusOf("CMB-20260803-012").status, "Closed");     // 结息自动归属
  // 部分付款：流水闭环但订单仍有余额
  const order = svc.db.prepare(`SELECT * FROM order_snapshots WHERE order_no='FL-T-011'`).get() as any;
  assert.ok(order);
});

test("重复评估幂等：不产生新版本、不新增异常", () => {
  const svc = AppService.open(":memory:", "test");
  svc.seedScene("flower");
  const before = {
    identities: (svc.db.prepare(`SELECT COUNT(*) n FROM money_identities`).get() as any).n,
    decisions: (svc.db.prepare(`SELECT COUNT(*) n FROM allocation_decisions`).get() as any).n,
    trusted: (svc.db.prepare(`SELECT COUNT(*) n FROM trusted_statuses`).get() as any).n,
    exceptions: (svc.db.prepare(`SELECT COUNT(*) n FROM exception_events`).get() as any).n,
  };
  svc.runEvaluation("ACC-FLOWER", "2026-08-03", undefined, "rerun");
  const after = {
    identities: (svc.db.prepare(`SELECT COUNT(*) n FROM money_identities`).get() as any).n,
    decisions: (svc.db.prepare(`SELECT COUNT(*) n FROM allocation_decisions`).get() as any).n,
    trusted: (svc.db.prepare(`SELECT COUNT(*) n FROM trusted_statuses`).get() as any).n,
    exceptions: (svc.db.prepare(`SELECT COUNT(*) n FROM exception_events`).get() as any).n,
  };
  assert.deepEqual(after, before);
});

test("手续费版本修正：差异流水重评估后 Closed，新版本不改写已闭环流水", () => {
  const svc = AppService.open(":memory:", "test");
  svc.seedScene("flower");
  // 银联商务差 10 元（60bps 理论 248500 vs 实际 247500）→ 修正费率为 100bps 后理论 247500 吻合
  svc.db.prepare(`INSERT INTO payment_companies(id,version,name,aliases,fee_rate_bps,fixed_fee_cents,calculation_level,rounding,effective_from,enabled,created_at,created_by)
    SELECT id,version+1,name,aliases,100,fixed_fee_cents,calculation_level,rounding,effective_from,enabled,?,? FROM payment_companies WHERE id='PC-UMS' ORDER BY version DESC LIMIT 1`)
    .run(new Date().toISOString(), "test");
  const versionsBefore = (svc.db.prepare(`SELECT COUNT(*) n FROM allocation_decisions`).get() as any).n;
  const run = svc.runEvaluation("ACC-FLOWER", "2026-08-03", undefined, "fee-fix");
  assert.ok(run.statementCount > 0);
  const ums = svc.db.prepare(`SELECT t.status FROM trusted_statuses t JOIN bank_statements s ON s.id=t.statement_id WHERE s.bank_serial_no='CMB-20260803-005' AND t.current=1`).get() as any;
  assert.equal(ums.status, "Closed", "费率修正后差异消除，流水闭合");
  const versionsAfter = (svc.db.prepare(`SELECT COUNT(*) n FROM allocation_decisions`).get() as any).n;
  assert.ok(versionsAfter > versionsBefore, "受影响流水产生新认领决策版本");
  const history = svc.db.prepare(`SELECT COUNT(*) n FROM trusted_statuses t JOIN bank_statements s ON s.id=t.statement_id WHERE s.bank_serial_no='CMB-20260803-005' AND t.status='Blocked'`).get() as any;
  assert.ok(history.n >= 1, "旧 Blocked 版本保留");
  const tlVersions = svc.db.prepare(`SELECT COUNT(*) n FROM allocation_decisions d JOIN bank_statements s ON s.id=d.statement_id WHERE s.bank_serial_no='CMB-20260803-001'`).get() as any;
  assert.equal(tlVersions.n, 1, "已确认历史不被重评估改写");
});

test("物业场景：自动闭环7笔、人工认领后闭环、差异与未识别保持Blocked", () => {
  const svc = AppService.open(":memory:", "test");
  svc.seedScene("property");
  const sum = svc.summary("ACC-PROPERTY", "2026-08-03");
  assert.equal(sum.byStatus.Closed?.count, 7);
  assert.equal(sum.byStatus.Blocked?.count, 6);
  // 预付卡 → 无应收归属
  const prepay = svc.db.prepare(`SELECT id FROM bank_statements WHERE bank_serial_no='CMB-20260803-105'`).get() as any;
  const r1 = svc.manualAllocate(prepay.id, { nonReceivableTypeId: "NRT-ADVANCE", evidence: "FA-001", note: "预付卡归属" });
  assert.ok(r1.ok, r1.error);
  // 九毛九 → 人工认领订单
  const jiu = svc.db.prepare(`SELECT id FROM bank_statements WHERE bank_serial_no='CMB-20260803-107'`).get() as any;
  const order = svc.db.prepare(`SELECT id FROM order_snapshots WHERE order_no='WY-T-002'`).get() as any;
  const r2 = svc.manualAllocate(jiu.id, { orderAllocations: [{ orderId: order.id, amountCents: 380000 }] });
  assert.ok(r2.ok, r2.error);
  const sum2 = svc.summary("ACC-PROPERTY", "2026-08-03");
  assert.equal(sum2.byStatus.Closed.count, 9);
  assert.equal(sum2.byStatus.Blocked.count, 4);
  // 差异异常人工关闭后复发（底层问题未解决）
  const diff = svc.db.prepare(`SELECT id FROM exception_events WHERE type='支付公司清算金额差异'`).get() as any;
  svc.acceptException(diff.id);
  const c1 = svc.closeException(diff.id, "外部核查完成", "函件");
  assert.ok(c1.ok);
  const reopened = svc.db.prepare(`SELECT status FROM exception_events WHERE id=?`).get(diff.id) as any;
  assert.equal(reopened.status, "DETECTED", "金额差异未解决，关闭后应重开");
  // 张伟未识别 → 需要第一层规则，不能直接关闭
  const zhang = svc.db.prepare(`SELECT id FROM bank_statements WHERE bank_serial_no='CMB-20260803-110'`).get() as any;
  const rz = svc.manualAllocate(zhang.id, { nonReceivableTypeId: "NRT-INTERNAL", evidence: "说明" });
  assert.equal(rz.ok, false);
});

test("凭证链完整：流水→身份→决策→状态 可追溯", () => {
  const svc = AppService.open(":memory:", "test");
  svc.seedScene("flower");
  const row = svc.db.prepare(
    `SELECT s.id, s.bank_serial_no, i.id mi, i.rule_id, d.id ad, d.coverage, t.id tms, t.status
     FROM bank_statements s
     JOIN money_identities i ON i.statement_id=s.id AND i.current=1
     JOIN allocation_decisions d ON d.statement_id=s.id AND d.current=1
     JOIN trusted_statuses t ON t.statement_id=s.id AND t.current=1
     WHERE s.bank_serial_no='CMB-20260803-006'`).get() as any;
  assert.ok(row.mi && row.ad && row.tms);
  assert.equal(row.rule_id, "L1-003");
  assert.equal(row.coverage, "FULL");
  assert.equal(row.status, "Closed");
});
