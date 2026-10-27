-- 业财一体资金运营平台 V3 · SQLite Schema
-- 金额单位：整数分（cents）。所有四层输出对象均为追加式版本记录。

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  bank TEXT NOT NULL,
  account_name TEXT NOT NULL,
  masked_no TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  created_at TEXT NOT NULL
);

-- 支付公司手续费预设：不可变版本表，调整参数即发布新版本
CREATE TABLE IF NOT EXISTS payment_companies (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL,            -- JSON string[]
  fee_rate_bps INTEGER NOT NULL,
  fixed_fee_cents INTEGER NOT NULL DEFAULT 0,
  calculation_level TEXT NOT NULL,  -- PER_ORDER | BATCH_TOTAL
  rounding TEXT NOT NULL,           -- HALF_UP | FLOOR | CEIL
  effective_from TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS non_receivable_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  auto_rule TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 1,
  evidence_required INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 规则：不可变版本表。已发布版本不可原位覆盖；调整必须发布新版本。
CREATE TABLE IF NOT EXISTS rules (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  layer INTEGER NOT NULL,           -- 1..3
  name TEXT NOT NULL,
  strategy TEXT NOT NULL,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  condition_text TEXT NOT NULL,
  action_text TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS rule_hits (
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, rule_version)
);

CREATE TABLE IF NOT EXISTS closure_policy (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

-- 银行流水接入：批次 + 不可变原始行 + 标准流水
CREATE TABLE IF NOT EXISTS bank_import_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  recon_date TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  file_hash TEXT NOT NULL,
  template_id TEXT,
  mapping_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  out_of_scope_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  conflict_rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_raw_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  raw_cells TEXT NOT NULL,
  row_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL,   -- IMPORTED | DUPLICATE | OUT_OF_SCOPE | REJECTED | CONFLICT
  error_codes TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  standard_statement_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_raw_batch ON bank_raw_rows(batch_id);

CREATE TABLE IF NOT EXISTS bank_statements (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  recon_date TEXT NOT NULL,
  bank_serial_no TEXT NOT NULL,
  booking_date TEXT NOT NULL,
  booking_time TEXT NOT NULL,
  payer_name TEXT,
  payer_account TEXT,
  payer_bank TEXT,
  memo TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  settlement_group_key TEXT,
  direction TEXT NOT NULL DEFAULT 'IN',
  import_batch_id TEXT NOT NULL,
  raw_row_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, bank_serial_no)
);
CREATE INDEX IF NOT EXISTS idx_stmt_ctx ON bank_statements(account_id, recon_date);

-- 业务订单接入：同步批次 + 原始记录 + 幂等版本快照
CREATE TABLE IF NOT EXISTS order_sync_runs (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  mode TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  duplicate INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS order_raw_records (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT,
  source_system TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL,              -- STANDARDIZED | REJECTED | QUARANTINED
  reject_reasons TEXT NOT NULL DEFAULT '[]',
  order_snapshot_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_oraw_run ON order_raw_records(sync_run_id);

CREATE TABLE IF NOT EXISTS order_snapshots (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  order_no TEXT NOT NULL,
  customer_code TEXT,
  customer_name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  payment_status TEXT NOT NULL,      -- 支付成功 | 待确定
  payment_company_id TEXT,
  payment_success_date TEXT,
  business_date TEXT NOT NULL,
  upstream_updated_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  raw_record_id TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source_system, external_order_id, version)
);
CREATE INDEX IF NOT EXISTS idx_order_current ON order_snapshots(source_system, external_order_id, version);

-- 评估批次
CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  recon_date TEXT NOT NULL,
  source TEXT NOT NULL,
  statement_ids TEXT NOT NULL DEFAULT '[]',
  stats TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_ctx ON evaluations(account_id, recon_date);

-- ① Money Identity Version
CREATE TABLE IF NOT EXISTS money_identities (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT,
  statement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  current INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,              -- IDENTIFIED | UNIDENTIFIED
  source_type TEXT,
  payment_company_id TEXT,
  rule_id TEXT,
  rule_version INTEGER,
  evidence TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mi_stmt ON money_identities(statement_id, current);

-- 认领组（资金成员 × 业务成员）
CREATE TABLE IF NOT EXISTS match_groups (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'CONFIRMED',   -- CONFIRMED | REVERSED
  origin TEXT NOT NULL,                        -- AUTO | MANUAL
  rule_id TEXT,
  rule_version INTEGER,
  relation_type TEXT NOT NULL,                 -- 1:1 | 1:N | N:1 | N:N
  edge_mode TEXT NOT NULL,                     -- DIRECT | GROUP_TOTAL
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  reversed_at TEXT
);

CREATE TABLE IF NOT EXISTS statement_parts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sp_group ON statement_parts(group_id);
CREATE INDEX IF NOT EXISTS idx_sp_stmt ON statement_parts(statement_id);

CREATE TABLE IF NOT EXISTS target_parts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  target_type TEXT NOT NULL,          -- BUSINESS_ORDER
  target_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tp_group ON target_parts(group_id);
CREATE INDEX IF NOT EXISTS idx_tp_target ON target_parts(target_type, target_id);

-- ② Allocation Decision Version
CREATE TABLE IF NOT EXISTS allocation_decisions (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT,
  statement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  current INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,               -- CONFIRMED | PENDING | NEED_REVIEW | REVERSED
  coverage TEXT NOT NULL,             -- NONE | PARTIAL | FULL
  target_type TEXT,                   -- BUSINESS_ORDER | NON_RECEIVABLE_TYPE | UNRESOLVED
  target_ids TEXT NOT NULL DEFAULT '[]',
  group_ids TEXT NOT NULL DEFAULT '[]',
  rule_id TEXT,
  rule_version INTEGER,
  basis TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  decided_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ad_stmt ON allocation_decisions(statement_id, current);

-- ③ Exception Event（稳定事件 + 版本历史）
CREATE TABLE IF NOT EXISTS exception_events (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  statement_ids TEXT NOT NULL,
  order_ids TEXT NOT NULL DEFAULT '[]',
  actual_cents INTEGER NOT NULL DEFAULT 0,
  expected_cents INTEGER NOT NULL DEFAULT 0,
  difference_cents INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  basis TEXT NOT NULL,
  route TEXT NOT NULL,
  severity TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,               -- DETECTED | PROCESSING | CLOSED
  version INTEGER NOT NULL DEFAULT 1,
  detected_at TEXT NOT NULL,
  processing_at TEXT,
  closed_at TEXT,
  closed_reason TEXT,
  close_evidence TEXT,
  history TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_ee_status ON exception_events(status);

-- ④ Trusted Money Status Version
CREATE TABLE IF NOT EXISTS trusted_statuses (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT,
  statement_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  current INTEGER NOT NULL DEFAULT 1,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,               -- Processing | Closed | Blocked
  identity_id TEXT,
  identity_version INTEGER,
  allocation_decision_id TEXT,
  allocation_decision_version INTEGER,
  open_exception_ids TEXT NOT NULL DEFAULT '[]',
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  basis TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts_stmt ON trusted_statuses(statement_id, current);

CREATE TABLE IF NOT EXISTS manual_nr_assignments (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  evidence TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL,
  confirmed_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  object TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);

-- API 输出：Webhook 订阅 + 投递记录
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,               -- JSON string[]: trusted_status.changed / exception.detected ...
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wd_pending ON webhook_deliveries(status);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                 -- admin | write | read
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
