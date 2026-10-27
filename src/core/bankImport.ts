import type { DB, IdGen } from "./db.js";
import { nowText, sha256Text, yuanToCents, normalize } from "./db.js";

/**
 * 银行流水导入：CSV / XLSX → 字段映射与校验预览 → 确认导入
 * 支持三类列头：通用模板、招行 CBS（表头自动探测）、光大/兴业列头别名
 * 去重键：银行账户 + 银行交易号；同号不同内容 → 冲突，不覆盖银行事实
 */

export type ValidationStatus = "IMPORTED" | "DUPLICATE" | "OUT_OF_SCOPE" | "REJECTED" | "CONFLICT";

export interface ParsedRow {
  rowNo: number;
  cells: Record<string, string>;
  bankSerialNo: string;
  bookingDate: string;
  bookingTime: string;
  direction: "IN" | "OUT";
  amountCents: number;
  payerName: string;
  payerAccount: string;
  payerBank: string;
  memo: string;
  currency: string;
  ownAccountTail: string;
  settlementGroupKey: string;
  reversalFlag: string;
}

export interface ParseIssue { rowNo: number; code: string; message: string; }

export interface ParseResult {
  headers: string[];
  headerRowIndex: number;
  rows: ParsedRow[];
  issues: ParseIssue[];
  templateId: string;
}

export interface ImportPreview {
  batchId: string;
  accountId: string;
  reconDate: string;
  fileName: string;
  fileHash: string;
  totalRows: number;
  counts: Record<ValidationStatus, number>;
  rows: Array<ParsedRow & { validationStatus: ValidationStatus; errorCodes: string[]; errorMessage: string }>;
  issues: ParseIssue[];
  templateId: string;
}

// 列头别名（标准键 → 各银行列头）
const COLUMN_ALIASES: Record<string, string[]> = {
  bankSerialNo: ["银行交易号", "流水号", "交易流水号", "银行流水号"],
  bookingDate: ["交易日期", "交易日", "记账日期", "入账日期"],
  bookingTime: ["交易时间", "记账时间", "入账时间"],
  direction: ["收支方向", "借贷标志", "收付标志"],
  incomeAmount: ["收入金额", "贷方金额(收入)", "贷方金额", "贷方发生额", "收入"],
  expenseAmount: ["支出金额", "借方金额(支出)", "借方金额", "借方发生额", "支出"],
  payerName: ["付款户名", "收(付)方名称", "对方户名", "交易对手名称"],
  payerAccount: ["付款账号", "收(付)方账号", "对方账号"],
  payerBank: ["收(付)方开户行名", "对方开户行", "付款开户行"],
  memo: ["摘要", "用途", "附言"],
  currency: ["币种", "货币"],
  ownAccountTail: ["本方账号尾号", "本方账号后四位"],
  ownAccount: ["账号", "本方账号"],
  ownAccountName: ["账号名称", "本方账户名称"],
  balance: ["余额"],
  valueDate: ["起息日"],
  reversalFlag: ["冲账标志", "冲正标志"],
  settlementGroupKey: ["内部编号", "清算组号", "清算批次"],
  transactionType: ["交易类型", "业务类型"],
};

export function detectHeader(rows: string[][]): { index: number; mapping: Record<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const header = rows[i].map(c => String(c ?? "").trim());
    const mapping: Record<string, number> = {};
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      const idx = header.findIndex(h => aliases.includes(h));
      if (idx >= 0) mapping[key] = idx;
    }
    // 必备列：流水号 + 日期 + 至少一个金额列
    if (mapping.bankSerialNo !== undefined && mapping.bookingDate !== undefined &&
        (mapping.incomeAmount !== undefined || mapping.expenseAmount !== undefined)) {
      return { index: i, mapping };
    }
  }
  return null;
}

function mapRows(matrix: string[][], headerIndex: number, mapping: Record<string, number>): { rows: ParsedRow[]; issues: ParseIssue[]; headers: string[] } {
  const headers = matrix[headerIndex].map(c => String(c ?? "").trim());
  const rows: ParsedRow[] = [];
  const issues: ParseIssue[] = [];
  for (let r = headerIndex + 1; r < matrix.length; r++) {
    const raw = matrix[r];
    if (!raw || raw.every(c => String(c ?? "").trim() === "")) continue;
    const cell = (key: string): string => {
      const idx = mapping[key];
      if (idx === undefined) return "";
      return String(raw[idx] ?? "").trim();
    };
    const income = yuanToCents(cell("incomeAmount"));
    const expense = yuanToCents(cell("expenseAmount"));
    const direction: "IN" | "OUT" = expense > 0 && income <= 0 ? "OUT" : "IN";
    const amountCents = direction === "IN" ? income : expense;
    const rowNo = r + 1;
    const bookingDate = normalizeDate(cell("bookingDate"));
    const row: ParsedRow = {
      rowNo,
      cells: Object.fromEntries(headers.map((h, i) => [h, String(raw[i] ?? "").trim()])),
      bankSerialNo: cell("bankSerialNo"),
      bookingDate,
      bookingTime: `${bookingDate} ${normalizeTime(cell("bookingTime") || "00:00:00")}`,
      direction,
      amountCents,
      payerName: cell("payerName"),
      payerAccount: cell("payerAccount"),
      payerBank: cell("payerBank"),
      memo: cell("memo"),
      currency: cell("currency") || "CNY",
      ownAccountTail: cell("ownAccountTail"),
      settlementGroupKey: cell("settlementGroupKey"),
      reversalFlag: cell("reversalFlag"),
    };
    if (!row.bankSerialNo) issues.push({ rowNo, code: "MISSING_SERIAL", message: "缺少银行交易号/流水号" });
    if (!bookingDate) issues.push({ rowNo, code: "MISSING_DATE", message: "缺少交易日期" });
    if (amountCents <= 0 && direction === "IN") issues.push({ rowNo, code: "MISSING_AMOUNT", message: "收入金额缺失或非正数" });
    rows.push(row);
  }
  return { rows, issues, headers };
}

export function normalizeDate(v: string): string {
  const s = String(v ?? "").trim().replace(/[./]/g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function normalizeTime(v: string): string {
  const m = String(v ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "00:00:00";
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}`;
}

/** 从 CSV 文本或 XLSX 矩阵解析银行流水（预览阶段） */
export function parseBankFile(matrix: string[][]): ParseResult {
  const head = detectHeader(matrix);
  if (!head) return { headers: [], headerRowIndex: -1, rows: [], issues: [{ rowNo: 0, code: "HEADER_NOT_FOUND", message: "未在前 30 行内检测到合法表头（需要流水号+日期+金额列）" }], templateId: "" };
  const { rows, issues, headers } = mapRows(matrix, head.index, head.mapping);
  const templateId = headers.some(h => ["贷方金额", "借方金额", "交易日"].includes(h)) ? "MAP-CBS" : "MAP-GEN";
  return { headers, headerRowIndex: head.index, rows, issues, templateId };
}

/** 生成导入预览（不去重落库，只校验） */
export function previewBankImport(db: DB, idGen: IdGen, opts: {
  accountId: string; reconDate: string; fileName: string; fileSize?: number; matrix: string[][]; actor?: string;
}): ImportPreview {
  const parsed = parseBankFile(opts.matrix);
  const batchId = idGen.next("BIMP");
  const fileHash = sha256Text(JSON.stringify(opts.matrix));
  const counts: Record<ValidationStatus, number> = { IMPORTED: 0, DUPLICATE: 0, OUT_OF_SCOPE: 0, REJECTED: 0, CONFLICT: 0 };

  const account = db.prepare(`SELECT masked_no FROM accounts WHERE id=?`).get(opts.accountId) as { masked_no: string } | undefined;
  const accountTail = account ? (account.masked_no.match(/(\d{4})$/)?.[1] ?? "") : "";
  const inBatch = new Map<string, string>();

  const rows = parsed.rows.map(row => {
    const errorCodes: string[] = [];
    let validationStatus: ValidationStatus;
    if (parsed.issues.some(i => i.rowNo === row.rowNo)) {
      validationStatus = "REJECTED";
      errorCodes.push(...parsed.issues.filter(i => i.rowNo === row.rowNo).map(i => i.code));
    } else if (row.direction === "OUT") {
      validationStatus = "OUT_OF_SCOPE";
    } else if (row.bookingDate !== opts.reconDate) {
      validationStatus = "REJECTED";
      errorCodes.push("DATE_MISMATCH");
    } else if (row.ownAccountTail && accountTail && row.ownAccountTail !== accountTail) {
      validationStatus = "REJECTED";
      errorCodes.push("ACCOUNT_MISMATCH");
    } else {
      // 批内去重优先：同批同号同内容 → DUPLICATE；同号不同内容 → CONFLICT
      const rowSig = JSON.stringify([row.bookingDate, row.amountCents, normalize(row.payerName), row.memo]);
      const seenInBatch = inBatch.get(row.bankSerialNo);
      if (seenInBatch) {
        validationStatus = seenInBatch === rowSig ? "DUPLICATE" : "CONFLICT";
      } else {
        inBatch.set(row.bankSerialNo, rowSig);
        const existing = db.prepare(`SELECT * FROM bank_statements WHERE account_id=? AND bank_serial_no=?`)
          .get(opts.accountId, row.bankSerialNo) as any;
        if (existing) {
          const same = existing.booking_date === row.bookingDate && existing.amount_cents === row.amountCents &&
            normalize(existing.payer_name) === normalize(row.payerName);
          validationStatus = same ? "DUPLICATE" : "CONFLICT";
        } else {
          validationStatus = "IMPORTED";
        }
      }
    }
    counts[validationStatus] += 1;
    return { ...row, validationStatus, errorCodes, errorMessage: errorCodes.join("/") };
  });

  return {
    batchId, accountId: opts.accountId, reconDate: opts.reconDate,
    fileName: opts.fileName, fileHash, totalRows: rows.length, counts,
    rows, issues: parsed.issues, templateId: parsed.templateId,
  };
}

/** 确认导入：写批次 + 全部原始行 + 标准流水（仅 IMPORTED） */
export function confirmBankImport(db: DB, idGen: IdGen, preview: ImportPreview, opts: {
  accountId: string; reconDate: string; actor: string; matrix: string[][];
}): { batchId: string; imported: number } {
  const createBatch = db.prepare(
    `INSERT INTO bank_import_batches(id,account_id,recon_date,file_name,file_size,file_hash,template_id,mapping_version,status,total_rows,imported_rows,duplicate_rows,out_of_scope_rows,rejected_rows,conflict_rows,created_at,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  createBatch.run(
    preview.batchId, opts.accountId, opts.reconDate, preview.fileName, null, preview.fileHash,
    preview.templateId, 1, "已导入", preview.totalRows, preview.counts.IMPORTED, preview.counts.DUPLICATE,
    preview.counts.OUT_OF_SCOPE, preview.counts.REJECTED, preview.counts.CONFLICT, nowText(), opts.actor,
  );

  const insertRaw = db.prepare(
    `INSERT INTO bank_raw_rows(id,batch_id,row_no,raw_cells,row_hash,validation_status,error_codes,error_message,standard_statement_id)
     VALUES(?,?,?,?,?,?,?,?,?)`);
  const insertStmt = db.prepare(
    `INSERT INTO bank_statements(id,account_id,recon_date,bank_serial_no,booking_date,booking_time,payer_name,payer_account,payer_bank,memo,amount_cents,currency,settlement_group_key,direction,import_batch_id,raw_row_id,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let imported = 0;
  for (const row of preview.rows) {
    const rawId = idGen.next("BRAW");
    let statementId: string | null = null;
    if (row.validationStatus === "IMPORTED") {
      statementId = idGen.next("BS");
      insertStmt.run(
        statementId, opts.accountId, opts.reconDate, row.bankSerialNo, row.bookingDate, row.bookingTime,
        row.payerName, row.payerAccount, row.payerBank, row.memo, row.amountCents, row.currency,
        row.settlementGroupKey, "IN", preview.batchId, rawId, nowText(),
      );
      imported += 1;
    }
    insertRaw.run(rawId, preview.batchId, row.rowNo, JSON.stringify(row.cells), sha256Text(JSON.stringify(row.cells)),
      row.validationStatus, JSON.stringify(row.errorCodes), row.errorMessage, statementId);
  }
  return { batchId: preview.batchId, imported };
}

/** 通用模板（与 V2 标准模板字段一致） */
export function bankTemplateMatrix(): string[][] {
  return [[
    "银行交易号", "交易日期", "交易时间", "收支方向", "收入金额", "付款户名", "付款账号", "摘要", "币种", "本方账号尾号", "清算组号",
  ]];
}
