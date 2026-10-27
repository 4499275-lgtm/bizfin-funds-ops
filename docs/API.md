# 接口文档（API Reference）

> Base URL：`http://<host>:8787/api/v1` ｜ 认证：`Authorization: Bearer <token>`
> 通用响应：`{"ok":true,"data":…}` 或 `{"ok":false,"error":"…"}`；金额单位一律**整数分**。
> 操作示例见 [API-示例](#8-完整调用示例)；角色说明见[权限](#2-认证与角色)。

## 目录
1. [系统](#1-系统) 2. [认证与角色](#2-认证与角色) 3. [账户](#3-账户) 4. [银行流水接入](#4-银行流水接入) 5. [订单接入](#5-订单接入) 6. [四层评估](#6-四层评估) 7. [查询](#7-查询) 8. [人工动作](#8-人工动作) 9. [规则中心](#9-规则中心) 10. [报表导出](#10-报表导出) 11. [Webhook 输出](#11-webhook-输出) 12. [演示](#12-演示) 13. [错误码](#13-错误码)

---

## 1. 系统

### GET /health
健康检查（无需认证）。
```json
{"status":"up","version":"3.0.0","time":"2026-10-27T08:00:00.000Z"}
```

## 2. 认证与角色

- 方式：`Authorization: Bearer <token>`（Token 由 CLI `token-add` 创建，服务端仅存 sha256）
- 角色：`read` < `write` < `admin`；未配置任何 Token 时为 **open 模式**（等价 admin，仅限本机开发）
- 失败：`401 {"ok":false,"error":"missing bearer token"}` / `403 {"ok":false,"error":"requires admin role"}`

## 3. 账户

### GET /accounts `read`
```json
{"ok":true,"data":[{"id":"ACC-001","bank":"招商银行","accountName":"佛山鲜花平台运营账户","maskedNo":"**** 0501"}]}
```

### POST /accounts `write`
```json
{"id":"ACC-002","bank":"光大银行","accountName":"××项目专户","maskedNo":"**** 6602"}
```
响应 `{"ok":true,"data":null}`；重复 id 幂等。

## 4. 银行流水接入

### POST /bank-statements/import `write`
支持三种载体，二选一：
- **multipart 文件**：字段 `accountId`、`reconDate`（YYYY-MM-DD）、`dryRun`（true/false）、`file`（.csv/.xlsx）
- **JSON rows**：`{"accountId","reconDate","dryRun","fileName?","rows":[["银行交易号","交易日期",…],…]}`（二维表，首行表头）
- **JSON csv 文本**：`{"accountId","reconDate","dryRun","csv":"…"}`

行为：解析（自动跳过 CBS 元信息行）→ 校验 → `dryRun=true` 只返回预览；否则落库（批次+原始行+标准流水）。

响应（dryRun）：
```json
{"ok":true,"data":{
  "dryRun":true,"batchId":"BIMP-0001","templateId":"MAP-CBS","fileHash":"…",
  "counts":{"IMPORTED":13,"DUPLICATE":0,"OUT_OF_SCOPE":0,"REJECTED":0,"CONFLICT":0},
  "rows":[{"rowNo":2,"bankSerialNo":"CMB-1","validationStatus":"IMPORTED","errorCodes":[]}]}}
```
响应（确认导入）：`{"counts":{…},"batchId":"BIMP-0001","imported":13}`

行级状态：`IMPORTED` 进入四层；`DUPLICATE` 同号同内容跳过；`CONFLICT` 同号不同内容（不覆盖银行事实）；`OUT_OF_SCOPE` 支出行；`REJECTED` 校验失败（errorCodes：`MISSING_SERIAL` / `MISSING_DATE` / `MISSING_AMOUNT` / `DATE_MISMATCH` / `ACCOUNT_MISMATCH`…）。

### GET /import-batches?accountId= `read`
返回批次列表（文件、哈希、模板、六类计数、时间）。

### GET /import-batches/:id/rows `read`
返回批次内**不可变原始行**：`rowNo`、`rawCells`（原始单元格）、`validationStatus`、`errorCodes`、`standardStatementId`。

## 5. 订单接入

### POST /orders/sync `write`
```json
{
  "sourceSystem": "SRC-ERP",
  "mode": "API 增量同步",
  "orders": [{
    "externalOrderId": "E-1001",
    "orderNo": "SO-20260802-01",
    "customerCode": "C001",
    "customerName": "佛山花境设计有限公司",
    "amountCents": 318080,
    "paymentStatus": "支付成功",
    "paymentCompanyId": "PC-TL",
    "paymentSuccessDate": "2026-08-02",
    "businessDate": "2026-08-02",
    "upstreamUpdatedAt": "2026-08-02 22:00:00"
  }]
}
```
- 幂等键 = `sourceSystem + externalOrderId`；内容相同 → `DUPLICATE`；字段变化 → 新版本快照（`UPDATED`）
- **冲突保护**：已被确认认领的订单，其金额/支付状态/支付公司/成功日发生变化 → 更新被**隔离**（`QUARANTINED`），并生成 `L3-008` 异常事件

响应：
```json
{"ok":true,"data":{"runId":"SYNC-0001","received":3,"inserted":2,"updated":0,"duplicate":0,
  "rejected":1,"quarantined":0,
  "rows":[{"externalOrderId":"A-3","status":"REJECTED","reasons":["待确定订单不得填写支付公司"],"rawRecordId":"ORAW-0003"}]}}
```

校验规则（REJECTED 原因）：支付成功必须填支付公司（且在主数据中）与支付成功时间；待确定不得填支付公司；amountCents 为正整数分；businessDate 为 YYYY-MM-DD；上游更新时间必填。

### GET /orders `read`
当前版本订单快照列表（含 version、支付状态、支付公司、成功日）。

## 6. 四层评估

### POST /evaluations/run `write`
```json
{"accountId":"ACC-001","reconDate":"2026-08-03","statementIds":["BS-0001"]}
```
`statementIds` 省略 = 全量；指定 = 增量重评估（只处理目标流水）。

响应：
```json
{"ok":true,"data":{"evaluationId":"EVAL-0007","statementCount":13,"identities":13,
  "decisions":13,"exceptionsNew":3,"exceptionsClosed":0,"trustedChanges":0,"webhookQueued":0}}
```
幂等性：签名未变化的流水不产生新版本。

### GET /evaluations?accountId=&reconDate= `read`
评估批次列表（来源、目标流水、统计、起止时间）。

## 7. 查询

### GET /bank-statements?accountId=&reconDate= `read`
每笔流水 + 四层当前结果：
```json
{"ok":true,"data":[{
  "id":"BS-0001","bankSerialNo":"CMB-20260803-001","bookingTime":"2026-08-03 09:05:12",
  "payerName":"通联支付网络服务股份有限公司","memo":"通联支付备付金清算款",
  "amountCents":994000,"settlementGroupKey":"TL-20260803-A",
  "identity":{"id":"MI-0001","version":1,"status":"IDENTIFIED","sourceType":"支付公司清算款",
              "paymentCompanyId":"PC-TL","ruleId":"L1-001","ruleVersion":1,"evidence":"…"},
  "decision":{"id":"AD-0001","version":1,"status":"CONFIRMED","coverage":"FULL",
              "targetType":"BUSINESS_ORDER","targetIds":["OSNP-0002"],"groupIds":["MG-0001"],"basis":"…"},
  "exceptions":[{"id":"EXC-0001","type":"…","status":"DETECTED","severity":"高","route":"…"}],
  "trusted":{"id":"TMS-0001","version":1,"status":"Closed","basis":"…","evaluatedAt":"…"},
  "orderGroups":[{"groupId":"MG-0001","relationType":"1:N","orderTargets":["OSNP-0002:3180.80"]}]
}]}
```

### GET /trusted-statuses?accountId=&reconDate= `read`
仅第四层对象（引用身份/决策版本、未关闭异常、策略版本、basis、evaluatedAt）。

### GET /match-groups?accountId=&reconDate= `read`
认领组（origin、rule、relationType、edgeMode、两侧成员与金额）。

### GET /exceptions?accountId=&status= `read`
异常事件（含 history 版本轨迹；`status=DETECTED|PROCESSING|CLOSED` 过滤）。

### GET /summary?accountId=&reconDate= `read`
```json
{"ok":true,"data":{"accountId":"ACC-001","reconDate":"2026-08-03","statements":13,"orders":14,
  "openExceptions":3,"byStatus":{"Closed":{"count":10,"amountCents":3976060},
  "Blocked":{"count":3,"amountCents":1002700}}}}
```

### GET /audit-events?limit= `read` ｜ GET /non-receivable-types `read` ｜ GET /closure-policy `read`

## 8. 人工动作

### POST /statements/:id/allocate `write`
第二层人工归属（订单认领与无应收类型**二选一**）：
```json
// 路径 A：关联业务订单（可拆多笔，合计 ≤ 流水可认领余额）
{"orderAllocations":[{"orderId":"OSNP-0010","amountCents":380000}],"note":"人工认领8月租金"}

// 路径 B：无应收资金类型（evidenceRequired 的类型必须填 evidence）
{"nonReceivableTypeId":"NRT-ADVANCE","evidence":"财务审批单 FA-001","note":"预付卡售卡款归属"}
```
成功后自动重评估该流水并触发 Webhook。失败（400）：身份未识别 / 已 FULL / 超余额 / 类型需凭据 / 二选一冲突。

### POST /exceptions/:id/accept `write`
受理（DETECTED → PROCESSING），记录版本历史。

### POST /exceptions/:id/close `write`
```json
{"reason":"外部核查完成：手续费调整","evidence":"对账函 UMS-202608-01"}
```
关闭后自动重评估相关流水；**底层问题未解决时，同指纹再次触发会以新版本重开**（设计行为）。

## 9. 规则中心

### GET /rules `read`
当前有效版本（含 hitCount 命中统计）。

### POST /rules/:id/versions `admin`
发布新版本（旧版本置 superseded，不可原位修改）：
```json
{"priority":15,"enabled":true,"effectiveFrom":"2026-09-01",
 "params":{"keywords":["结息","利息","存款利息"]},"conditionText":"…","actionText":"…"}
```
响应 `{"ok":true,"data":{"id":"L1-002","version":2}}`

### GET /payment-companies `read` ｜ POST /payment-companies/:id/versions `admin`
```json
{"feeRateBps":100,"fixedFeeCents":0,"calculationLevel":"PER_ORDER","rounding":"HALF_UP","effectiveFrom":"2026-09-01"}
```

## 10. 报表导出

| 端点 | 格式 | 内容 |
|---|---|---|
| GET /export/trusted-status?accountId=&reconDate=&format=json\|csv\|xlsx | json/csv/xlsx | 可信资金状态（对外交付契约） |
| GET /export/daily-report?accountId=&reconDate=&format=csv\|xlsx | csv/xlsx | 勾兑日报表（流水×四层×汇总行） |
| GET /export/exceptions?accountId=&format=csv\|xlsx | csv/xlsx | 异常清单 |
| GET /export/match-groups?accountId=&reconDate=&format=csv\|xlsx | csv/xlsx | 认领组明细 |
| GET /export/audit?limit= | csv | 审计记录 |
| GET /templates/bank.csv ｜ /templates/orders.csv ｜ /templates/orders.xlsx | csv/xlsx | 导入模板 |

导出响应带 `Content-Disposition: attachment`；xlsx 为 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`。

## 11. Webhook 输出

### POST /webhooks `admin`
```json
{"url":"https://erp.example.com/hooks/funds","secret":"<随机串>","events":["trusted_status.changed"]}
```
`events` 支持 `trusted_status.changed` 与 `*`。GET /webhooks 列表；GET /webhooks/deliveries 投递记录；POST /webhooks/flush 重试 PENDING。

### 事件载荷 trusted_status.changed
```json
{"account_id":"ACC-001","recon_date":"2026-08-03","statement_id":"BS-0001",
 "bank_serial_no":"CMB-20260803-001","amount_cents":994000,
 "status":"Closed","basis":"资金已识别且完成全部业务订单归属","version":1,"evaluated_at":"…",
 "allocation_decision":{"id":"AD-0001","version":1},"open_exceptions":[]}
```

### 签名校验（接收方示例，Node）
```js
import { createHmac } from "node:crypto";
const expected = createHmac("sha256", SECRET)
  .update(`${req.headers["x-bfo-delivery"]}.${req.headers["x-bfo-timestamp"]}.${rawBody}`)
  .digest("hex");
if (`sha256=${expected}` !== req.headers["x-bfo-signature"]) return res.status(401).end();
```
投递策略：同步尝试一次，失败保持 PENDING 可重试，≥10 次失败置 FAILED；超时 10 秒。

## 12. 演示

### POST /demo/seed `write`
```json
{"scene":"flower"}   // flower | property
```
灌入演示场景（订单+流水）并完成评估；返回评估批次与状态分布。**仅用于演示/培训数据库。**

## 13. 错误码

| HTTP | 场景 |
|---|---|
| 400 | 参数缺失/格式错误、业务校验失败（error 字段含中文原因） |
| 401 | 未带或无效 Token |
| 403 | 角色不足（write/admin 要求） |
| 404 | 对象不存在（批次、规则等） |
| 500 | 服务器内部错误（查看服务日志） |
