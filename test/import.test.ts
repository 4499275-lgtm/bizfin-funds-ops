import { test } from "node:test";
import assert from "node:assert/strict";
import { AppService } from "../src/core/service.js";
import { parseBankFile, previewBankImport, bankTemplateMatrix } from "../src/core/bankImport.js";
import { syncOrders } from "../src/core/orderSync.js";
import { parseCsv, toCsv, readXlsxMatrix, writeXlsx } from "../src/export/files.js";
import { openDb, IdGen } from "../src/core/db.js";

test("CSV 解析：引号、逗号、换行、BOM", () => {
  const csv = "\uFEFFa,b,c\n\"x,1\",\"y\"\"z\",\"line\nbreak\"\n";
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["x,1", 'y"z', "line\nbreak"]);
});

test("CSV 往返不丢数据", () => {
  const rows = [["a", "b,c", 'd"e'], ["1", "2", "3"]];
  const back = parseCsv(toCsv(rows));
  assert.deepEqual(back, rows);
});

test("XLSX 写读往返", async () => {
  const buf = await writeXlsx([{ name: "T", rows: [["银行交易号", "金额"], ["X-1", 100]] }]);
  const matrix = await readXlsxMatrix(buf);
  assert.equal(matrix[0][0], "银行交易号");
  assert.equal(matrix[1][0], "X-1");
});

test("银行导入：批内重复/跨批重复/冲突/日期错/支出行", () => {
  const svc = AppService.open(":memory:", "test");
  svc.ensureSeeded();
  svc.ensureAccount({ id: "ACC-T", bank: "测试银行", accountName: "测试账户", maskedNo: "**** 0501" });
  const mk = (serial: string, date: string, amount: string, payer: string, memo = "测试") =>
    [[serial, date, "10:00:00", "收入", amount, payer, "6222", memo, "CNY", "0501", ""]];
  const header = bankTemplateMatrix();

  const p1 = previewBankImport(svc.db, new IdGen(svc.db), {
    accountId: "ACC-T", reconDate: "2026-08-03", fileName: "t.csv", matrix: [...header, ...mk("S-1", "2026-08-03", "100.00", "甲"), ...mk("S-1", "2026-08-03", "100.00", "甲"), ...mk("S-2", "2026-08-03", "200.00", "乙"), ...mk("S-2", "2026-08-03", "999.00", "乙"), ...mk("S-3", "2026-08-04", "50.00", "丙"), ...mk("S-4", "2026-08-03", "0", "丁")],
  });
  const byStatus = (s: string) => p1.rows.filter(r => r.validationStatus === s).length;
  assert.equal(byStatus("IMPORTED"), 2);
  assert.equal(byStatus("DUPLICATE"), 1);
  assert.equal(byStatus("CONFLICT"), 1);
  assert.equal(byStatus("REJECTED"), 2); // 日期不符 + 金额缺失

  const imp = svc.previewBankImport({ accountId: "ACC-T", reconDate: "2026-08-03", fileName: "t.csv", matrix: [...header, ...mk("S-1", "2026-08-03", "100.00", "甲"), ...mk("S-2", "2026-08-03", "200.00", "乙")] });
  svc.confirmBankImport(imp, imp.rows.map(r => Object.values(r.cells)));
  // 跨批重复
  const p2 = previewBankImport(svc.db, new IdGen(svc.db), {
    accountId: "ACC-T", reconDate: "2026-08-03", fileName: "t2.csv", matrix: [...header, ...mk("S-1", "2026-08-03", "100.00", "甲")],
  });
  assert.equal(p2.counts.DUPLICATE, 1);
});

test("银行导入：招行 CBS 表头自动探测（元信息行跳过）", () => {
  const matrix = [
    ["账号", "7559xxxx0501"],
    ["账号名称", "测试运营账户"],
    ["期初余额", "10000.00"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["账号", "账号名称", "币种", "交易日", "交易时间", "交易类型", "借方金额", "贷方金额", "余额", "摘要", "流水号", "收(付)方名称", "收(付)方账号", "内部编号"],
    ["7559", "测试", "人民币", "2026-08-03", "09:00:00", "银联清算入账", "", "17395.00", "27395.00", "通联清算款", "CBS-1", "通联支付网络服务股份有限公司", "6222", "TL-A"],
  ];
  const parsed = parseBankFile(matrix);
  assert.equal(parsed.headerRowIndex, 4);
  assert.equal(parsed.templateId, "MAP-CBS");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].direction, "IN");
  assert.equal(parsed.rows[0].amountCents, 1739500);
  assert.equal(parsed.rows[0].settlementGroupKey, "TL-A");
});

test("订单同步：校验拒绝 / 幂等 / 版本更新", () => {
  const svc = AppService.open(":memory:", "test");
  svc.ensureSeeded();
  const o = {
    externalOrderId: "E-1", orderNo: "ON-1", customerName: "客户甲", amountCents: 10000,
    paymentStatus: "支付成功", paymentCompanyId: "PC-TL", paymentSuccessDate: "2026-08-02",
    businessDate: "2026-08-02", upstreamUpdatedAt: "2026-08-03 10:00:00",
  };
  const r1 = syncOrders(svc.db, new IdGen(svc.db), { sourceSystem: "S1", orders: [o, { ...o }], mode: "测试", actor: "t" });
  assert.equal(r1.inserted, 1);
  assert.equal(r1.duplicate, 1);
  // 非法组合
  const bad = syncOrders(svc.db, new IdGen(svc.db), {
    sourceSystem: "S1", mode: "测试", actor: "t",
    orders: [
      { ...o, externalOrderId: "E-2", paymentCompanyId: undefined },
      { ...o, externalOrderId: "E-3", paymentStatus: "待确定" },
      { ...o, externalOrderId: "E-4", paymentStatus: "待确定", paymentCompanyId: "PC-TL" },
      { ...o, externalOrderId: "E-5", amountCents: 0 },
    ] as any,
  });
  assert.equal(bad.rejected, 4);
  // 更新生成新版本
  const r2 = syncOrders(svc.db, new IdGen(svc.db), { sourceSystem: "S1", mode: "测试", actor: "t", orders: [{ ...o, amountCents: 20000 }] });
  assert.equal(r2.updated, 1);
  const versions = svc.db.prepare(`SELECT version FROM order_snapshots WHERE source_system='S1' AND external_order_id='E-1' ORDER BY version`).all() as any[];
  assert.deepEqual(versions.map(v => v.version), [1, 2]);
});

test("订单同步：已确认认领订单关键字段变化 → 隔离 + L3-008", () => {
  const svc = AppService.open(":memory:", "test");
  svc.seedScene("flower"); // FL-T-011 已有部分认领边
  const order = svc.db.prepare(`SELECT * FROM order_snapshots WHERE order_no='FL-T-011'`).get() as any;
  const r = svc.syncOrders("SRC-FLOWER", [{
    externalOrderId: order.external_order_id ?? "EXT-011", orderNo: "FL-T-011", customerName: "花开活动策划工作室",
    amountCents: 99900, paymentStatus: "待确定", businessDate: "2026-08-02", upstreamUpdatedAt: "2026-08-03 23:00:00",
  }], "冲突测试");
  assert.equal(r.quarantined, 1);
  const exc = svc.db.prepare(`SELECT * FROM exception_events WHERE type='已认领订单变化冲突'`).get() as any;
  assert.ok(exc, "应生成 L3-008 异常");
  // 订单快照未被覆盖
  const cur = svc.db.prepare(`SELECT amount_cents FROM order_snapshots WHERE id=?`).get(order.id) as any;
  assert.equal(cur.amount_cents, 500000);
});
