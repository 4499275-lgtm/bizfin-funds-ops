# 报表导入导出

## 导入：银行流水

入口：`POST /api/v1/bank-statements/import`（multipart 文件 / JSON rows|csv）、CLI `import-bank`、控制台上传。

两步操作：`dryRun=true` 预览校验（不写库）→ 确认导入（写批次+原始行+标准流水）。新导入流水需运行四层评估。

### 表头识别

自动扫描前 30 行检测表头（跳过招行 CBS 对账单的账户元信息行）。三类列头别名：

| 标准键 | 通用模板 | 招行 CBS | 光大 | 兴业 |
|---|---|---|---|---|
| 流水号 | 银行交易号 | 流水号 | — | — |
| 日期 | 交易日期 | 交易日 | 交易日期 | 记账日期 |
| 收入 | 收入金额 | 贷方金额 | 贷方发生额 | 贷方金额(收入) |
| 支出 | 支出金额 | 借方金额 | 借方发生额 | 借方金额(支出) |
| 付款方 | 付款户名 | 收(付)方名称 | — | — |

### 行级校验分类

| validationStatus | 含义 |
|---|---|
| IMPORTED | 进入四层 |
| DUPLICATE | 同号同内容（批内或库内），跳过 |
| CONFLICT | 同号不同内容（日期/金额/付款方），**不覆盖银行事实**，需人工处理 |
| OUT_OF_SCOPE | 支出/借方行，仅留存原始行 |
| REJECTED | 缺流水号/日期、金额缺失、勾兑日不符、本方账号尾号不符（错误码：MISSING_SERIAL、DATE_MISMATCH、ACCOUNT_MISMATCH…） |

## 导入：业务订单

入口：`POST /api/v1/orders/sync`（JSON）、CLI `import-orders`（CSV/XLSX）、控制台模板。

字段（10 列模板）：来源订单ID*、业务订单号*、客户编号、客户名称*、订单金额(元)*、支付状态*（支付成功/待确定）、支付公司（条件必填）、支付成功时间（条件必填）、业务日期*、上游更新时间*。

校验拒绝组合：支付成功缺支付公司/成功时间；待确定填了支付公司；金额非正；支付公司不在主数据。

幂等与冲突：键=源系统+来源订单ID；相同跳过（DUPLICATE）；变化生成新版本快照（旧版本 superseded）；**已确认认领订单的金额/状态/支付公司/成功日变化 → 更新被隔离（QUARANTINED）+ L3-008 异常**。

## 导出

| 端点 | 内容 | 格式 |
|---|---|---|
| `/export/trusted-status` | 每笔流水的可信状态 + 前三层对象引用（对外交付契约） | json / csv / xlsx |
| `/export/daily-report` | 勾兑日报表：流水×四层结果×归属目标×汇总行 | csv / xlsx |
| `/export/exceptions` | 异常清单（含实际/理论/差异金额、定位、路径、关闭记录） | csv / xlsx |
| `/export/match-groups` | 认领组明细（两侧成员与金额、规则版本、证据模式） | csv / xlsx |
| `/export/audit` | 审计记录 | csv |
| `/templates/bank.csv`、`/templates/orders.csv|xlsx` | 导入模板 | csv / xlsx |

CSV 统一 UTF-8（RFC4180），XLSX 首行表头加粗冻结。Excel 打开中文无需额外设置（UTF-8 BOM 可按需在前置网关补）。
