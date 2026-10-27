import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/api/server.js";
import { openDb } from "../src/core/db.js";

async function makeApp() {
  const db = openDb({ file: ":memory:" });
  const app = await buildServer({ db, publicDir: "/nonexistent" });
  await app.ready();
  return { db, app };
}

test("API：演示场景 + 查询 + 导出", async () => {
  const { app } = await makeApp();
  const seed = await app.inject({ method: "POST", url: "/api/v1/demo/seed", payload: { scene: "flower" } });
  assert.equal(seed.statusCode, 200);
  assert.equal(seed.json().data.evaluation.statementCount, 13);

  const stmts = await app.inject({ url: "/api/v1/bank-statements?accountId=ACC-FLOWER&reconDate=2026-08-03" });
  assert.equal(stmts.json().data.length, 13);
  const tl = stmts.json().data.find((s: any) => s.bankSerialNo === "CMB-20260803-001");
  assert.equal(tl.trusted.status, "Closed");
  assert.equal(tl.identity.sourceType, "支付公司清算款");

  const summary = await app.inject({ url: "/api/v1/summary?accountId=ACC-FLOWER&reconDate=2026-08-03" });
  assert.equal(summary.json().data.byStatus.Closed.count, 10);

  const csv = await app.inject({ url: "/api/v1/export/daily-report?accountId=ACC-FLOWER&reconDate=2026-08-03&format=csv" });
  assert.ok(csv.body.includes("银行交易号"));
  const xlsx = await app.inject({ url: "/api/v1/export/daily-report?accountId=ACC-FLOWER&reconDate=2026-08-03&format=xlsx" });
  assert.ok(xlsx.payload.length > 1000);
  assert.equal(xlsx.statusCode, 200);
  const json = await app.inject({ url: "/api/v1/export/trusted-status?accountId=ACC-FLOWER&reconDate=2026-08-03" });
  assert.equal(json.json().statements.length, 13);
});

test("API：人工认领与异常生命周期", async () => {
  const { app } = await makeApp();
  await app.inject({ method: "POST", url: "/api/v1/demo/seed", payload: { scene: "property" } });
  const stmts = await app.inject({ url: "/api/v1/bank-statements?accountId=ACC-PROPERTY&reconDate=2026-08-03" }).then(r => r.json().data);
  const prepay = stmts.find((s: any) => s.bankSerialNo === "CMB-20260803-105");
  const r1 = await app.inject({
    method: "POST", url: `/api/v1/statements/${prepay.id}/allocate`,
    payload: { nonReceivableTypeId: "NRT-ADVANCE", evidence: "FA-001", note: "预付卡归属" },
  });
  assert.equal(r1.json().ok, true);
  const excs = await app.inject({ url: "/api/v1/exceptions?accountId=ACC-PROPERTY" }).then(r => r.json().data);
  const diff = excs.find((e: any) => e.type === "支付公司清算金额差异");
  const acc = await app.inject({ method: "POST", url: `/api/v1/exceptions/${diff.id}/accept` });
  assert.equal(acc.json().ok, true);
  // 校验类错误
  const bad = await app.inject({
    method: "POST", url: `/api/v1/statements/${prepay.id}/allocate`,
    payload: { nonReceivableTypeId: "NRT-DEPOSIT" },
  });
  assert.equal(bad.statusCode, 400); // 已 FULL
});

test("API：Token 认证与角色控制", async () => {
  const { db, app } = await makeApp();
  const svcToken = "bfo_test_token_123";
  db.prepare(`INSERT INTO api_tokens(token_hash,name,role,created_at) VALUES(?,'t','write',datetime('now'))`)
    .run((await import("node:crypto")).createHash("sha256").update(svcToken).digest("hex"));
  // 有 token 存在时未带 token 应 401
  const noAuth = await app.inject({ url: "/api/v1/accounts" });
  assert.equal(noAuth.statusCode, 401);
  const seed = await app.inject({ method: "POST", url: "/api/v1/demo/seed", headers: { authorization: `Bearer ${svcToken}` }, payload: { scene: "flower" } });
  assert.equal(seed.statusCode, 200);
  const withAuth = await app.inject({ url: "/api/v1/accounts", headers: { authorization: `Bearer ${svcToken}` } });
  assert.equal(withAuth.statusCode, 200);
  // write 角色不能发规则版本（admin）
  const rule = await app.inject({
    method: "POST", url: "/api/v1/rules/L1-001/versions", headers: { authorization: `Bearer ${svcToken}` },
    payload: { priority: 15 },
  });
  assert.equal(rule.statusCode, 403);
});

test("API：webhook 注册与投递记录（不可达地址不崩溃）", async () => {
  const { app } = await makeApp();
  await app.inject({ method: "POST", url: "/api/v1/demo/seed", payload: { scene: "flower" } });
  const reg = await app.inject({
    method: "POST", url: "/api/v1/webhooks",
    payload: { url: "http://127.0.0.1:9/unreachable", secret: "s3cret", events: ["trusted_status.changed"] },
  });
  assert.equal(reg.statusCode, 200);
  // 触发一次状态变化：人工认领支付宝流水
  const stmts = await app.inject({ url: "/api/v1/bank-statements?accountId=ACC-FLOWER&reconDate=2026-08-03" }).then(r => r.json().data);
  const ali = stmts.find((s: any) => s.bankSerialNo === "CMB-20260803-003");
  await app.inject({
    method: "POST", url: `/api/v1/statements/${ali.id}/allocate`,
    payload: { nonReceivableTypeId: "NRT-ADVANCE", evidence: "说明", note: "测试" },
  });
  const flush = await app.inject({ method: "POST", url: "/api/v1/webhooks/flush" });
  assert.equal(flush.statusCode, 200);
  const deliveries = await app.inject({ url: "/api/v1/webhooks/deliveries" }).then(r => r.json().data);
  assert.ok(deliveries.length >= 1);
  assert.ok(["RETRY", "PENDING", "FAILED"].includes(deliveries[0].status));
});

test("API：规则中心版本发布", async () => {
  const { app } = await makeApp();
  const rules = await app.inject({ url: "/api/v1/rules" }).then(r => r.json().data);
  assert.equal(rules.filter((r: any) => r.layer === 1).length, 3);
  assert.ok(rules.find((r: any) => r.id === "L2-001"));
  const v2 = await app.inject({
    method: "POST", url: "/api/v1/rules/L2-001/versions",
    payload: { params: { toleranceCents: 100, maxCombination: 500 } },
  });
  assert.equal(v2.json().data.version, 2);
  const rules2 = await app.inject({ url: "/api/v1/rules" }).then(r => r.json().data);
  const l2 = rules2.find((r: any) => r.id === "L2-001");
  assert.equal(l2.version, 2);
  assert.equal(l2.params.toleranceCents, 100);
});

test("API：导入模板与原始行追溯", async () => {
  const { app } = await makeApp();
  const tpl = await app.inject({ url: "/api/v1/templates/bank.csv" });
  assert.ok(tpl.body.includes("银行交易号"));
  await app.inject({ method: "POST", url: "/api/v1/demo/seed", payload: { scene: "flower" } });
  const batches = await app.inject({ url: "/api/v1/import-batches?accountId=ACC-FLOWER" }).then(r => r.json().data);
  assert.ok(batches.length >= 1);
  const rows = await app.inject({ url: `/api/v1/import-batches/${batches[0].id}/rows` }).then(r => r.json().data);
  assert.ok(rows.length >= 13);
  assert.ok(rows[0].rawCells["银行交易号"]);
});
