import type { DB, IdGen } from "./db.js";
import { nowText } from "./db.js";

/** 主数据与规则基线：与《V2 产品设计与演示指引》一致（L1/L2/L3 各规则 + 无应收类型目录 + 闭环策略） */
export function seedMasterData(db: DB, idGen: IdGen, actor = "system"): void {
  const ts = nowText();
  const insPC = db.prepare(`INSERT INTO payment_companies(id,version,name,aliases,fee_rate_bps,fixed_fee_cents,calculation_level,rounding,effective_from,enabled,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  const pcs: Array<[string, string, string[], number]> = [
    ["PC-TL", "通联支付", ["通联支付", "通联清算", "通联支付网络服务股份有限公司"], 60],
    ["PC-CFT", "财付通", ["财付通", "微信支付", "财付通支付科技有限公司"], 60],
    ["PC-ALI", "支付宝", ["支付宝", "支付宝（中国）", "支付宝（中国）网络技术有限公司"], 60],
    ["PC-UMS", "银联商务", ["银联商务", "银联商务股份有限公司"], 60],
  ];
  for (const [id, name, aliases, rate] of pcs) {
    insPC.run(id, 1, name, JSON.stringify(aliases), rate, 0, "PER_ORDER", "HALF_UP", "2026-01-01", 1, ts, actor);
  }

  const insRule = db.prepare(`INSERT INTO rules(id,version,layer,name,strategy,priority,enabled,effective_from,params,condition_text,action_text,description,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rules: Array<any> = [
    ["L1-001", 1, "支付公司清算款识别", "identify_payment_company", 10, {}, "付款户名或摘要命中支付公司别名", "输出支付公司清算款及支付公司", "只识别资金来自哪家支付公司，不判断是否存在订单。"],
    ["L1-002", 1, "银行结息识别", "identify_nonbusiness", 20, { keywords: ["结息", "利息"], interestTypeId: "NRT-INTEREST" }, "摘要包含结息或利息", "输出非业务入账来源", "来源识别完成后，仍需第二层形成无应收资金归属。"],
    ["L1-003", 1, "明确银行转账识别", "identify_transfer", 30, { keywords: ["订单款", "汇款", "定金", "尾款", "部分付款", "租金", "押金", "物业费"] }, "摘要含企业订单号或明确转账用途关键词", "输出银行转账", "不是兜底规则；规则未覆盖的资金必须保持未识别。"],
    ["L2-001", 1, "支付公司T+1订单组认领", "allocate_payment_company", 10, { toleranceCents: 0, maxCombination: 500 }, "同支付公司、固定T+1日期窗、扣预设手续费后金额一致", "确认业务订单认领组", "周一取周五六日，其他日期取前一天；多笔银行流水只有显式组号相同才允许N:N汇总。"],
    ["L2-002", 1, "转账订单号聚合认领", "allocate_transfer_reference", 20, { toleranceCents: 0, maxCombination: 10 }, "摘要明确包含订单号且金额可闭合", "确认1:1或N:1认领组", "待确定订单按订单号匹配一笔或多笔银行转账。"],
    ["L2-003", 1, "转账客户汇总认领", "allocate_transfer_customer_sum", 30, { toleranceCents: 0, maxCombination: 8 }, "付款方与客户一致且多笔订单金额合计相等", "确认1:N认领组", "同一付款方的一笔转账可匹配多笔待确定订单。"],
    ["L2-004", 1, "订单号明确的部分付款", "allocate_transfer_partial", 40, { toleranceCents: 0, maxCombination: 1 }, "订单号唯一且到账小于订单剩余", "整笔流水确认到该订单", "流水可全部闭环，订单仍保留未勾兑余额。"],
    ["L2-005", 1, "无应收资金类型归属", "allocate_non_receivable", 50, { interestTypeId: "NRT-INTEREST" }, "命中已配置无应收资金类型并满足证据要求", "形成无需订单认领的归属决策", "可以无应收，但必须有资金归属；其他暂收不等于财务收入。"],
    ["L3-001", 1, "支付公司清算金额差异", "exception_settlement_difference", 10, { severity: "高", route: "检查手续费预设与成功订单范围" }, "实际清算款不等于成功订单扣费后理论金额", "输出支付公司清算差异事件", "只定位差额，不进入支付公司每日明细。"],
    ["L3-002", 1, "支付公司业务归属待确认", "exception_payment_company_no_orders", 15, { severity: "高", route: "补同步订单或转无应收资金归属" }, "候选日无成功订单，且尚未确认合法无应收资金类型", "输出业务归属待确认事件", "没有订单本身不等于异常；没有订单且没有合法资金归属时才阻塞。"],
    ["L3-003", 1, "银行转账多候选/候选待确认", "exception_multiple_candidates", 20, { severity: "中", route: "转第二层人工认领" }, "存在多个可解释待确定订单（或唯一候选待确认）", "输出候选事件", "第三层只定位并给出处理路径。"],
    ["L3-004", 1, "银行转账无候选", "exception_no_candidate", 30, { severity: "中", route: "等待订单同步或确认无应收归属" }, "没有可解释待确定订单", "输出无候选事件", "订单同步未完成时先处于Processing，完成评估后才形成异常。"],
    ["L3-005", 1, "资金来源未识别", "exception_unidentified", 5, { severity: "高", route: "补充第一层识别规则或人工确认来源" }, "第一层执行后无规则命中", "输出来源未识别事件", "未识别是规则覆盖不足，不能自动当作银行转账。"],
    ["L3-006", 1, "流水未完成认领", "exception_unallocated_balance", 40, { severity: "高", route: "转第二层补充认领决策" }, "完整评估后仍有未归属余额", "输出未闭环余额事件", "部分认领不是Processing终态。"],
    ["L3-007", 1, "手续费规则缺失", "exception_fee_missing", 8, { severity: "高", route: "维护支付公司手续费预设" }, "支付公司资金无有效手续费版本", "输出规则缺失事件", "缺少计算依据时不猜测理论到账。"],
    ["L3-008", 1, "已认领订单变化冲突", "exception_order_conflict", 6, { severity: "高", route: "回业务系统核实并审批后重做认领" }, "已确认认领的订单发生关键字段变化", "输出业务数据冲突事件", "订单同步不得静默覆盖已确认资金关系。"],
  ];
  for (const [id, version, name, strategy, priority, params, cond, action, desc] of rules) {
    const layer = id.startsWith("L1") ? 1 : id.startsWith("L2") ? 2 : 3;
    insRule.run(id, version, layer, name, strategy, priority, 1, "2026-01-01", JSON.stringify(params), cond, action, desc, ts, actor);
  }

  const insNRT = db.prepare(`INSERT INTO non_receivable_types(id,name,category,auto_rule,approval_required,evidence_required,enabled,sort) VALUES(?,?,?,?,?,?,?,?)`);
  const nrts: Array<[string, string, string, string, 0 | 1, 0 | 1, number]> = [
    ["NRT-INTEREST", "银行结息", "收益类", "摘要含结息/利息", 0, 0, 1],
    ["NRT-ADVANCE", "预收款/暂收款", "负债类", "人工选择", 1, 1, 2],
    ["NRT-DEPOSIT", "押金/保证金", "负债类", "人工选择", 1, 1, 3],
    ["NRT-LOAN", "借款或融资款", "负债类", "人工选择", 1, 1, 4],
    ["NRT-CAPITAL", "资本投入", "权益类", "人工选择", 1, 1, 5],
    ["NRT-INTERNAL", "内部往来款", "往来类", "人工选择", 1, 1, 6],
    ["NRT-PC-ADJUST", "支付公司差错/调整款", "待处理类", "人工选择", 1, 1, 7],
  ];
  for (const [id, name, category, auto, approval, evidence, sort] of nrts) {
    insNRT.run(id, name, category, auto, approval, evidence, 1, sort);
  }

  db.prepare(`INSERT INTO closure_policy(id,version,name,description,effective_from,created_at) VALUES(?,?,?,?,?,?)`)
    .run("CLOSE-POLICY-001", 1, "单账户收入资金闭环策略",
      "存在未关闭阻塞异常 → Blocked；银行导入、订单同步或四层作业正常未完成 → Processing；资金已识别且第二层完成全额业务订单或合法无应收归属且无开放异常 → Closed。",
      "2026-01-01", ts);

  db.prepare(`INSERT INTO meta(key,value) VALUES('seeded_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(ts);
  void idGen;
}

export interface SceneOrder {
  externalOrderId: string; orderNo: string; customerCode: string; customerName: string;
  amountCents: number; paymentStatus: "支付成功" | "待确定"; paymentCompanyId: string;
  paymentSuccessDate: string; businessDate: string;
}
export interface SceneStatement {
  bankSerialNo: string; bookingTime: string; payerName: string; amountCents: number;
  memo: string; settlementGroupKey: string; payerAccount?: string; payerBank?: string;
}
export interface Scene {
  account: { id: string; bank: string; accountName: string; maskedNo: string };
  sourceSystem: string;
  reconDate: string;
  orders: SceneOrder[];
  statements: SceneStatement[];
}

export const FLOWER_SCENE: Scene = {
  account: { id: "ACC-FLOWER", bank: "招商银行", accountName: "佛山鲜花平台运营账户", maskedNo: "**** 0501" },
  sourceSystem: "SRC-FLOWER",
  reconDate: "2026-08-03",
  orders: [
    ["EXT-001", "FL-260731-01", "C001", "佛山花境设计有限公司", 320000, "支付成功", "PC-TL", "2026-07-31"],
    ["EXT-002", "FL-260801-01", "C002", "南海拾花社", 200000, "支付成功", "PC-TL", "2026-08-01"],
    ["EXT-003", "FL-260802-01", "C003", "顺德春日会展有限公司", 480000, "支付成功", "PC-TL", "2026-08-02"],
    ["EXT-004", "FL-260731-02", "C004", "岭南酒店管理有限公司", 500000, "支付成功", "PC-CFT", "2026-07-31"],
    ["EXT-005", "FL-260801-02", "C005", "鲜意空间陈列有限公司", 300000, "支付成功", "PC-CFT", "2026-08-01"],
    ["EXT-006", "FL-260802-02", "C006", "佛山悦心婚礼策划有限公司", 250000, "支付成功", "PC-UMS", "2026-08-02"],
    ["EXT-007", "FL-T-007", "C007", "王一晨", 258000, "待确定", "", ""],
    ["EXT-008", "FL-T-008", "C008", "佛山花境设计有限公司", 320000, "待确定", "", ""],
    ["EXT-009", "FL-T-009", "C008", "佛山花境设计有限公司", 200000, "待确定", "", ""],
    ["EXT-010", "FL-T-010", "C009", "佛山悦心婚礼策划有限公司", 1000000, "待确定", "", ""],
    ["EXT-011", "FL-T-011", "C010", "花开活动策划工作室", 500000, "待确定", "", ""],
    ["EXT-012", "FL-T-012", "C011", "佛山花予生活馆", 360000, "待确定", "", ""],
    ["EXT-013", "FL-T-013", "C012", "南海拾花社", 360000, "待确定", "", ""],
    ["EXT-014", "FL-T-014", "C014", "佛山星愿文化有限公司", 150000, "待确定", "", ""],
  ].map(([externalOrderId, orderNo, customerCode, customerName, amountCents, paymentStatus, paymentCompanyId, date]: any) => ({
    externalOrderId, orderNo, customerCode, customerName, amountCents, paymentStatus,
    paymentCompanyId, paymentSuccessDate: date || "", businessDate: date || "2026-08-02",
  })),
  statements: [
    ["CMB-20260803-001", "09:05:12", "通联支付网络服务股份有限公司", 994000, "通联支付备付金清算款", "TL-20260803-A"],
    ["CMB-20260803-002", "09:11:08", "财付通支付科技有限公司", 400000, "财付通备付金清算款第一笔", "CFT-20260803-A"],
    ["CMB-20260803-003", "09:13:26", "支付宝（中国）网络技术有限公司", 395200, "支付宝备付金清算款，未关联业务订单", "ALI-20260803-A"],
    ["CMB-20260803-004", "09:15:41", "财付通支付科技有限公司", 395200, "财付通备付金清算款第二笔", "CFT-20260803-A"],
    ["CMB-20260803-005", "09:20:05", "银联商务股份有限公司", 247500, "银联商务清算款", "UMS-20260803-A"],
    ["CMB-20260803-006", "10:02:18", "王一晨", 258000, "FL-T-007 鲜花订单款", ""],
    ["CMB-20260803-007", "10:18:40", "佛山花境设计有限公司", 520000, "8月鲜花订单汇款", ""],
    ["CMB-20260803-008", "10:31:12", "佛山悦心婚礼策划有限公司", 400000, "FL-T-010 定金", ""],
    ["CMB-20260803-009", "11:06:33", "佛山悦心婚礼策划有限公司", 600000, "FL-T-010 尾款", ""],
    ["CMB-20260803-010", "11:28:09", "花开活动策划工作室", 250000, "FL-T-011 部分付款", ""],
    ["CMB-20260803-011", "13:15:50", "张伟", 360000, "鲜花采购款", ""],
    ["CMB-20260803-012", "14:03:05", "招商银行股份有限公司", 8860, "季度银行结息", ""],
    ["CMB-20260803-013", "15:20:28", "佛山星愿文化有限公司", 150000, "FL-T-014 鲜花订单款", ""],
  ].map(([bankSerialNo, bookingTime, payerName, amountCents, memo, settlementGroupKey]: any) => ({
    bankSerialNo, bookingTime, payerName, amountCents, memo, settlementGroupKey,
  })),
};

export const PROPERTY_SCENE: Scene = {
  account: { id: "ACC-PROPERTY", bank: "招商银行", accountName: "华发商都运营账户", maskedNo: "**** 0501" },
  sourceSystem: "SRC-PROPERTY",
  reconDate: "2026-08-03",
  orders: [
    ["EXT-P-001", "WY-260731-001", "T001", "华发商都-F201优衣库", 850000, "支付成功", "PC-TL", "2026-07-31"],
    ["EXT-P-002", "WY-260731-002", "T002", "华发商都-F301星巴克", 620000, "支付成功", "PC-TL", "2026-07-31"],
    ["EXT-P-003", "WY-260801-001", "T003", "中海环宇城-B1百佳超市", 1500000, "支付成功", "PC-CFT", "2026-08-01"],
    ["EXT-P-004", "WY-260801-002", "T004", "中海环宇城-L1华为体验店", 480000, "支付成功", "PC-CFT", "2026-08-01"],
    ["EXT-P-005", "WY-260802-001", "T005", "利和广场-F3江渔儿", 320000, "支付成功", "PC-ALI", "2026-08-02"],
    ["EXT-P-006", "WY-260802-002", "T006", "利和广场-L1周大福", 1250000, "支付成功", "PC-UMS", "2026-08-02"],
    ["EXT-P-007", "WY-260731-003", "T007", "华发商都-地下停车场", 280000, "支付成功", "PC-TL", "2026-07-31"],
    ["EXT-P-008", "WY-260801-003", "T008", "中海环宇城-物业费-5楼办公区", 960000, "支付成功", "PC-CFT", "2026-08-01"],
    ["EXT-P-009", "WY-T-001", "T009", "华发商都租户-猫酷科技", 500000, "待确定", "", ""],
    ["EXT-P-010", "WY-T-002", "T010", "中海环宇城租户-九毛九餐饮", 380000, "待确定", "", ""],
    ["EXT-P-011", "WY-T-003", "T011", "利和广场租户-名创优品", 220000, "待确定", "", ""],
    ["EXT-P-012", "WY-T-004", "T012", "华发商都租户-海底捞", 800000, "待确定", "", ""],
    ["EXT-P-013", "WY-T-005", "T013", "中海环宇城租户-屈臣氏", 150000, "待确定", "", ""],
  ].map(([externalOrderId, orderNo, customerCode, customerName, amountCents, paymentStatus, paymentCompanyId, date]: any) => ({
    externalOrderId, orderNo, customerCode, customerName, amountCents, paymentStatus,
    paymentCompanyId, paymentSuccessDate: date || "", businessDate: date || "2026-08-02",
  })),
  statements: [
    ["CMB-20260803-101", "09:05:12", "通联支付网络服务股份有限公司", 1739500, "通联支付备付金清算款", "TL-20260803-A"],
    ["CMB-20260803-102", "09:11:08", "财付通支付科技有限公司", 2922360, "财付通备付金清算款", "CFT-20260803-A"],
    ["CMB-20260803-103", "09:13:26", "支付宝（中国）网络技术有限公司", 318080, "支付宝备付金清算款", "ALI-20260803-A"],
    ["CMB-20260803-104", "09:20:05", "银联商务股份有限公司", 1240000, "银联商务清算款", "UMS-20260803-A"],
    ["CMB-20260803-105", "09:35:40", "支付宝（中国）网络技术有限公司", 200000, "预付卡售卡款结算", "ALI-20260803-B"],
    ["CMB-20260803-106", "10:02:18", "华发商都租户-猫酷科技", 500000, "WY-T-001 租金", ""],
    ["CMB-20260803-107", "10:18:40", "中海环宇城租户-九毛九餐饮", 380000, "8月租金", ""],
    ["CMB-20260803-108", "10:31:12", "利和广场租户-名创优品", 220000, "8月租金", ""],
    ["CMB-20260803-109", "11:06:33", "华发商都租户-海底捞", 500000, "WY-T-004 部分付款", ""],
    ["CMB-20260803-110", "13:15:50", "张伟", 360000, "转账", ""],
    ["CMB-20260803-111", "14:03:05", "招商银行股份有限公司", 8860, "季度银行结息", ""],
    ["CMB-20260803-112", "14:30:00", "华发商都-新租户-盒马鲜生", 1000000, "租赁押金", ""],
    ["CMB-20260803-113", "15:20:28", "中海环宇城租户-屈臣氏", 150000, "WY-T-005 租金", ""],
  ].map(([bankSerialNo, bookingTime, payerName, amountCents, memo, settlementGroupKey]: any) => ({
    bankSerialNo, bookingTime, payerName, amountCents, memo, settlementGroupKey,
  })),
};
