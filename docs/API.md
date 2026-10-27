# API 与报表示例

Base URL：`http://localhost:8787/api/v1`。认证：`Authorization: Bearer <token>`（未配置 token 时为 open 模式）。

## 1. 银行流水导入

multipart（推荐，支持 CSV/XLSX）：

```bash
curl -X POST http://localhost:8787/api/v1/bank-statements/import \
  -H "Authorization: Bearer $TOKEN" \
  -F accountId=ACC-001 -F reconDate=2026-08-03 -F dryRun=true \
  -F file=@samples/demo_鲜花场景_银行流水.xlsx
```

JSON（程序接入）：

```bash
curl -X POST .../api/v1/bank-statements/import \
  -H 'content-type: application/json' \
  -d '{"accountId":"ACC-001","reconDate":"2026-08-03",
       "csv":"银行交易号,交易日期,交易时间,收入金额,付款户名,摘要\nCMB-1,2026-08-03,09:00:00,100.00,某某公司,货款"}'
```

响应（dryRun）：

```json
{"ok":true,"data":{"dryRun":true,"batchId":"BIMP-0001","counts":
  {"IMPORTED":13,"DUPLICATE":0,"OUT_OF_SCOPE":0,"REJECTED":0,"CONFLICT":0},
  "templateId":"MAP-CBS","rows":[{"rowNo":2,"bankSerialNo":"...","validationStatus":"IMPORTED"}]}}
```

去掉 `dryRun` 或设为 `false` 即落库并返回 `batchId/imported`。

## 2. 订单同步

```bash
curl -X POST .../api/v1/orders/sync -H 'content-type: application/json' -d '{
  "sourceSystem": "SRC-ERP",
  "orders": [{
    "externalOrderId": "E-1001", "orderNo": "SO-20260802-01",
    "customerName": "佛山花境设计有限公司", "amountCents": 318080,
    "paymentStatus": "支付成功", "paymentCompanyId": "PC-TL",
    "paymentSuccessDate": "2026-08-02",
    "businessDate": "2026-08-02", "upstreamUpdatedAt": "2026-08-02 22:00:00"
  }]}'
```

行级结果：`INSERTED / UPDATED / DUPLICATE / REJECTED(带原因) / QUARANTINED`。
校验：支付成功必须有支付公司+成功日期；待确定不得有支付公司；金额为正整数分。

## 3. 运行评估 / 查询 / 人工动作

```bash
curl -X POST .../api/v1/evaluations/run -d '{"accountId":"ACC-001","reconDate":"2026-08-03"}'
curl '.../api/v1/bank-statements?accountId=ACC-001&reconDate=2026-08-03'
curl '.../api/v1/summary?accountId=ACC-001&reconDate=2026-08-03'
curl '.../api/v1/trusted-statuses?accountId=ACC-001&reconDate=2026-08-03'

# 第二层人工归属：订单认领（金额分）或无应收类型（二选一）
curl -X POST .../api/v1/statements/BS-0001/allocate -d '{
  "orderAllocations":[{"orderId":"OSNP-0001","amountCents":380000}],
  "note":"人工认领8月租金"}'
curl -X POST .../api/v1/statements/BS-0002/allocate -d '{
  "nonReceivableTypeId":"NRT-ADVANCE","evidence":"FA-001","note":"预付卡售卡款归属"}'

# 异常生命周期
curl -X POST .../api/v1/exceptions/EXC-0001/accept
curl -X POST .../api/v1/exceptions/EXC-0001/close \
  -d '{"reason":"外部核查完成：手续费调整","evidence":"对账函 UMS-202608-01"}'
```

## 4. 报表导出

```bash
curl '.../export/daily-report?accountId=ACC-001&reconDate=2026-08-03&format=xlsx' -o 勾兑日报表.xlsx
curl '.../export/trusted-status?accountId=ACC-001&reconDate=2026-08-03' -o trusted.json
curl '.../export/exceptions?accountId=ACC-001&format=csv' -o exceptions.csv
curl '.../export/match-groups?accountId=ACC-001&reconDate=2026-08-03&format=csv'
curl '.../export/audit?limit=1000'
curl '.../templates/bank.csv' -o bank_template.csv
```

可信状态 JSON 结构（对外唯一统一交付）：

```json
{
  "account": {"id":"ACC-001","bank":"招商银行","account_name":"...","masked_no":"**** 0501"},
  "recon_date": "2026-08-03",
  "statements": [{
    "bank_statement_id": "BS-0001", "bank_serial_no": "CMB-20260803-001",
    "amount_cents": 994000, "status": "Closed",
    "money_identity": {"id":"MI-0001","version":1,"source_type":"支付公司清算款","payment_company_id":"PC-TL","rule_id":"L1-001","rule_version":1},
    "allocation_decision": {"id":"AD-0001","version":1,"status":"CONFIRMED","coverage":"FULL","target_type":"BUSINESS_ORDER","target_ids":["OSNP-0002"]},
    "open_exceptions": [],
    "closure_policy": {"id":"CLOSE-POLICY-001","version":1},
    "basis": "资金已识别且完成全部业务订单归属",
    "evaluated_at": "2026-08-03 16:00:00", "status_version": 1
  }]
}
```

## 5. Webhook 输出

```bash
curl -X POST .../api/v1/webhooks -d '{
  "url":"https://erp.example.com/hooks/funds","secret":"s3cret",
  "events":["trusted_status.changed"]}'
```

评估/人工动作导致可信状态变化时投递 POST，请求头：
`X-BFO-Event: trusted_status.changed`、`X-BFO-Delivery: WD-0001`、`X-BFO-Timestamp`、
`X-BFO-Signature: sha256=<hex(hmac_sha256(secret, deliveryId.timestamp.body))>`。
失败保留 PENDING 并可 `POST /webhooks/flush` 重试；≥10 次失败置 FAILED。

## 6. 规则中心（版本化，admin）

```bash
curl '.../rules'                       # 当前有效版本 + 命中统计
curl -X POST '.../rules/L1-002/versions' -d '{"params":{"keywords":["结息","利息","存款利息"]}}'   # → version+1
curl -X POST '.../payment-companies/PC-UMS/versions' -d '{"feeRateBps":100}'                     # → version+1
```

已发布版本不可原位覆盖；输出对象记录命中的准确规则版本。
