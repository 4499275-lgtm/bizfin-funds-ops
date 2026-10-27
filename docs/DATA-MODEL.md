# 数据模型

金额一律整数分（cents）。所有表见 `src/core/schema.sql`，此处说明核心对象与关系。

## 接入对象

| 表 | 说明 | 关键字段 |
|---|---|---|
| `accounts` | 银行账户（作业上下文） | id, bank, account_name, masked_no |
| `bank_import_batches` | 一次银行文件导入 | 账户、勾兑日、文件哈希、模板、导入/重复/支出/失败/冲突数量 |
| `bank_raw_rows` | 不可变原始行 | row_no、raw_cells(JSON)、row_hash、validation_status、standard_statement_id |
| `bank_statements` | 标准收入流水（四层消费的基础事实） | account_id+bank_serial_no 唯一；booking_date/time、payer_*、amount_cents、settlement_group_key |
| `order_sync_runs` / `order_raw_records` | 订单同步批次与原始记录 | 幂等键=source_system+external_order_id；STANDARDIZED/REJECTED/QUARANTINED |
| `order_snapshots` | 订单版本快照 | version 递增，superseded_at 置旧；payment_status 仅 支付成功/待确定 |

## 四层输出版本对象

| 表 | 语义 |
|---|---|
| `money_identities` | ① status: IDENTIFIED/UNIDENTIFIED；source_type: 支付公司清算款/非业务入账/银行转账；命中 rule_id+version；evidence |
| `match_groups` + `statement_parts` + `target_parts` | ② 认领组：资金成员（流水×金额）×业务成员（订单×金额）；relation_type 1:1/1:N/N:1/N:N；edge_mode DIRECT（有逐笔证据）/GROUP_TOTAL（仅组总额） |
| `allocation_decisions` | ② status CONFIRMED/PENDING/NEED_REVIEW；coverage FULL/PARTIAL/NONE；target_type BUSINESS_ORDER/NON_RECEIVABLE_TYPE/UNRESOLVED |
| `exception_events` | ③ 稳定事件：type/rule/severity/location/responsibility/route；status DETECTED/PROCESSING/CLOSED；fingerprint 唯一；history JSON |
| `trusted_statuses` | ④ Processing/Closed/Blocked；引用 identity/decision 版本与未关闭异常；policy_id+version |

## 主数据与治理

| 表 | 说明 |
|---|---|
| `payment_companies` | 手续费预设版本（fee_rate_bps、fixed_fee_cents、PER_ORDER/BATCH_TOTAL、HALF_UP/FLOOR/CEIL、生效日） |
| `rules` | 三层规则版本（strategy、priority、params JSON、生效区间） |
| `non_receivable_types` | 无应收资金类型目录（审批/凭据要求） |
| `closure_policy` | 唯一闭环策略版本 |
| `rule_hits` | 规则命中统计（按版本） |
| `evaluations` | 评估批次 |
| `audit_events` | 审计链 |
| `manual_nr_assignments` | 无应收类型人工归属（凭据+确认人） |

## 审计链示例

```
bank_import_batches → bank_raw_rows → bank_statements
→ money_identities(v1..) → allocation_decisions(v1..) → match_groups
→ exception_events(v1.., DETECTED→PROCESSING→CLOSED)
→ trusted_statuses(v1.., Processing→Blocked→Closed)
→ webhook_deliveries（对外发布记录）
```

## 一笔资金的闭环判定（closure policy）

```
Blocked    = 存在未关闭阻塞异常
Closed     = 当前身份 IDENTIFIED 且当前决策 CONFIRMED/FULL 且无未关闭阻塞异常
Processing = 其余（作业未完成）
```
