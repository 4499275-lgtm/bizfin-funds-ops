# bizfin-funds-ops · 业财一体资金运营平台

> 单账户日终收入勾兑的四层引擎生产版。从本地单文件 HTML DEMO（V2.0）移植并补齐生产化能力：
> **REST API 接入与输出 · CSV/XLSX 报表导入导出 · 版本化规则中心 · HMAC Webhook · 审计与凭证链**。

- 语言/运行时：TypeScript · Node.js ≥ 22.5（推荐 24，内置 `node:sqlite`，零原生编译）
- 存储：SQLite（WAL，单文件，易于备份/部署）
- 服务：Fastify + 内置 Web 控制台（静态页，零前端构建）
- 测试：`node:test`，20 个用例（含与 V2 DEMO 基线一致的场景回归）

## 产品口径（与 V2 基线一致）

平台面向**一个银行账户、一个入账日期**的日终收入勾兑，只处理收入流水，不替代业务系统/ERP/银行/支付公司。
四层能力各自拥有独立输入、输出、状态与规则，输出全部为**追加式版本对象**：

| 层 | 能力 | 输出对象 |
|---|---|---|
| ① | 资金识别：这笔入账是什么资金、从哪里来 | Money Identity Version |
| ② | 资金认领：归属于什么业务（应收关联 / 仅业务归属） | Allocation Decision Version + 认领组（资金成员×业务成员） |
| ③ | 资金异常：哪个环节阻塞、由谁到哪里处理 | Exception Event（稳定事件 + 版本历史） |
| ④ | 可信资金状态：能否作为可信资金状态对外发布 | Trusted Money Status Version（Closed / Processing / Blocked） |

关键口径：
- 支付公司清算款按**固定 T+1 窗口**（周一取周五六日，其他日取前一日）+ 预设手续费理论到账做**汇总认领**；多流水×多订单只有显式组号相同才允许 N:N（GROUP_TOTAL，不伪造逐笔对应）；
- 银行转账支持订单号认领、客户汇总认领（子集和）、唯一订单号部分付款；
- 「没有订单 ≠ 异常」：无应收资金必须有受控的业务归属（无应收资金类型目录），才能闭环；
- 已发布规则不可原位修改（新版本驱动执行）；人工决策不被自动重评估静默覆盖；异常关闭必须有依据。

## 快速开始

```bash
npm install
npm run build

# 初始化并导入演示场景（鲜花：10 Closed / 3 Blocked）
node dist/src/cli.js seed-demo --db data/funds.db --scene flower

# 启动服务（含 Web 控制台 http://localhost:8787）
node dist/src/cli.js serve --db data/funds.db --port 8787
```

打开 `http://localhost:8787` 即是内置控制台（工作台/导入/评估/异常/导出）。

### Docker

```bash
docker compose up --build   # 端口 8787，数据卷 ./data
```

## CLI

```bash
node dist/src/cli.js init --db data/funds.db
node dist/src/cli.js seed-demo --db data/funds.db --scene flower|property
node dist/src/cli.js import-bank --db data/funds.db --account ACC-001 --date 2026-08-03 --file samples/银行流水.csv [--dry-run]
node dist/src/cli.js import-orders --db data/funds.db --source SRC-1 --file samples/订单.xlsx
node dist/src/cli.js run --db data/funds.db --account ACC-001 --date 2026-08-03
node dist/src/cli.js export --db data/funds.db --type trusted|daily|exceptions --account ACC-001 --date 2026-08-03 --format csv|xlsx|json --out out.csv
node dist/src/cli.js token-add --db data/funds.db --name ops --role write
node dist/src/cli.js webhook-add --db data/funds.db --url https://erp.example.com/hooks/funds --secret s3cret --events trusted_status.changed
```

## API 概览（全部 `/api/v1`，Bearer Token 认证）

接入（写）：
- `POST /bank-statements/import` —— 银行流水导入：multipart 文件（CSV/XLSX）或 JSON `{rows|csv}`；`dryRun=true` 只做校验预览（重复/冲突/支出/失败分类）
- `POST /orders/sync` —— 业务订单同步：幂等键=源系统+来源订单ID；校验拒绝进入隔离；已确认认领订单关键字段变化 → 隔离 + L3-008 异常
- `POST /evaluations/run` —— 运行四层评估（可指定流水子集做增量重评估）
- `POST /statements/:id/allocate` —— 第二层人工归属（订单认领 或 无应收类型，二选一）
- `POST /exceptions/:id/accept` / `POST /exceptions/:id/close` —— 异常受理 / 关闭（关闭必填依据）

查询（读）：
- `GET /accounts` `GET /bank-statements` `GET /orders` `GET /match-groups` `GET /exceptions` `GET /trusted-statuses` `GET /evaluations` `GET /summary` `GET /audit-events` `GET /import-batches(/:id/rows)`
- 规则中心：`GET /rules`、`POST /rules/:id/versions`（admin）、`GET /payment-companies`、`POST /payment-companies/:id/versions`、`GET /non-receivable-types`、`GET /closure-policy`

输出：
- `GET /export/trusted-status?format=json|csv|xlsx` —— 可信资金状态（对外唯一统一交付结果）
- `GET /export/daily-report?format=csv|xlsx` —— 勾兑日报表（含汇总行）
- `GET /export/exceptions` `GET /export/match-groups` `GET /export/audit`
- 模板：`GET /templates/bank.csv` `GET /templates/orders.csv|xlsx`
- Webhook：`POST /webhooks`（admin）→ `trusted_status.changed` 事件，HMAC-SHA256 签名（`X-BFO-Signature`），`POST /webhooks/flush` 重试投递

完整请求/响应示例见 [docs/API.md](docs/API.md)，架构与数据模型见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/DATA-MODEL.md](docs/DATA-MODEL.md)，导入导出格式见 [docs/IMPORT-EXPORT.md](docs/IMPORT-EXPORT.md)。

## 报表导入导出

| 方向 | 内容 | 格式 |
|---|---|---|
| 导入 | 银行流水（通用模板 / 招行 CBS 对账单自动探测，光大/兴业列头别名） | CSV、XLSX |
| 导入 | 业务订单（10 字段模板，条件必填校验） | CSV、XLSX、API JSON |
| 导出 | 可信资金状态（对外交付） | JSON、CSV、XLSX |
| 导出 | 勾兑日报表（流水×四层结果×汇总） | CSV、XLSX |
| 导出 | 异常清单 / 认领组明细 / 审计 | CSV、XLSX |

## 从 DEMO 迁移了什么

V2.0 DEMO（单文件 HTML + localStorage）已验证四层模型的产品语义；本仓库把它移植为后端引擎并保持行为一致：

- 鲜花场景：自动闭环 10 笔，Blocked 3 笔（支付宝无订单归属待确认、银联差异 10 元、张伟未识别）——与 DEMO 使用说明一致；
- 物业场景：自动闭环 7 笔，人工确认 4 笔，异常 2 笔——与 DEMO 使用说明一致；
- `test/engine.test.ts` 即为该基线的回归测试。

生产化补强（DEMO 明确排除、本仓库实现）：后端持久化、REST API、Token 认证与角色、幂等订单同步 + 冲突隔离（L3-008）、批内/跨批去重与冲突检测、不可变规则版本表、评估批次、Webhook 输出、CSV/XLSX 报表、Docker 部署、CI。

仍不在范围（沿用 V2 边界）：付出流水、支付渠道维度、支付公司每日明细、实时回调、退款/凭证/收入确认、银行直连。

## 目录结构

```
src/
├── core/            # 领域引擎（框架无关）
│   ├── schema.sql   # 全量表结构（版本对象追加式）
│   ├── context.ts   # 单账户×单日工作区
│   ├── engine.ts    # 四层评估 + 版本化 + 异常同步 + 编排
│   ├── actions.ts   # 人工认领 / 异常受理关闭
│   ├── bankImport.ts / orderSync.ts / seed.ts / service.ts
├── api/             # Fastify 服务、认证、Webhook
├── export/          # XLSX/CSV 读写 + 报表
├── cli.ts / index.ts
public/              # 内置 Web 控制台
test/                # node:test 回归（V2 基线场景）
samples/             # DEMO 场景 Excel（鲜花/物业）
docs/                # 架构 / API / 数据模型 / 导入导出 / 规则
```

## 开发

```bash
npm test          # 构建 + 全部测试
npm run build     # tsc + 拷贝 schema.sql
```

License: MIT
