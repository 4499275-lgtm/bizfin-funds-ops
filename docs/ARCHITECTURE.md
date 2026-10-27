# 架构

## 总体

```
业务系统 ──POST /orders/sync──┐
                              │
银行文件/API ──POST /bank-statements/import──┤
                              ▼
                    ┌─────────────────────┐
                    │  接入层（幂等/校验/  │
                    │  批次/原始行/隔离区） │
                    └─────────┬───────────┘
                              ▼  不可变事实
        ┌─────────────────────────────────────┐
        │        四层引擎（WorkContext）        │
        │  ① 识别 → Money Identity Version     │
        │  ② 认领 → Allocation Decision Ver.   │
        │          + MatchGroup(资金×业务成员)  │
        │  ③ 异常 → Exception Event(稳定事件)   │
        │  ④ 状态 → Trusted Money Status Ver.  │
        └───────┬──────────────┬──────────────┘
                ▼              ▼
        SQLite（WAL）    Webhook（HMAC）/ 导出报表 / Web 控制台
```

## 分层

- **core/**（领域层，框架无关）：`WorkContext` 在内存装载「单账户×单日」的工作集（流水、当前订单快照、最新规则/手续费版本、认领组、当前版本对象），引擎在其上按 V2 语义评估，结果全部落库。金额一律整数分。
- **api/**（接口层）：Fastify 路由、Bearer Token 认证（read/write/admin）、multipart 上传、Webhook 投递。
- **export/**（报表层）：CSV（RFC4180）与 XLSX（exceljs）双向适配 + 报表查询。
- **public/**（控制台）：静态单页，仅调用 `/api/v1`，不承担业务逻辑。

## 版本化机制（与 V2 一致，落库实现）

- `money_identities` / `allocation_decisions` / `trusted_statuses`：追加式，`(statement_id, current=1)` 为当前版本；签名（signature）不变则复用（重评估幂等），变化则旧版本 `current=0` 并插入新版本。
- `exception_events`：稳定事件，`fingerprint = ruleId|type|statementIds` 唯一；诊断依据变化追加版本；关闭后复发重开新版本；阻塞解除需有新证据（相关资金 CONFIRMED/FULL 或身份已识别）。
- `rules` / `payment_companies`：不可变版本表（`superseded_at`），执行时取各 id 的 MAX(version)。
- `evaluations`：评估批次（来源、目标流水、统计），审计事件引用批次。

## 增量重评估

`POST /evaluations/run` 可传 `statementIds` 子集：只对目标流水重新识别/决策/发状态；自动认领规则（L2-001..004）只在目标流水及其候选范围内创建认领组；订单同步后同理。已 CONFIRMED/FULL 的历史不被自动重评估改写（手续费/规则新版本仅影响未闭环或重新打开的流水）。

## 并发与事务

- SQLite WAL + `busy_timeout`；单进程服务部署（Node 单线程）；每个写操作（导入/同步/评估/人工动作）在单连接顺序执行，天然串行化。
- 多副本部署建议：单写节点 + 只读副本（Litestream/物理备份），或未来切换 Postgres（SQL 方言已尽量标准化，JSON 列仅存储/整读）。

## 安全

- `Authorization: Bearer <token>`：token 仅存 sha256 哈希；角色 read < write < admin（规则/手续费/Webhook 管理需 admin）。
- 未配置任何 token 时为 open 模式（仅限本地开发），启动时警告。
- Webhook：`X-BFO-Signature: sha256=hmac_sha256(secret, deliveryId.timestamp.body)`，10 次失败标记 FAILED。

## 明确排除（沿 V2 边界）

付出流水、支付渠道维度、订单收款主体/预计结算周期、支付公司每日交易/清算明细、实时支付回调、平台创建业务主数据、勾兑后回写业务支付状态、退款/会计凭证/收入确认、生产级银行直连。
