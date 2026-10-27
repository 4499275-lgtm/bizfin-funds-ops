import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DB = DatabaseSync;

export interface OpenOptions {
  file: string;
  /** 默认开启 WAL 与外键约束 */
  journal?: "WAL" | "DELETE";
}

export function openDb(opts: OpenOptions): DB {
  if (opts.file !== ":memory:") {
    mkdirSync(dirname(opts.file), { recursive: true });
  }
  const db = new DatabaseSync(opts.file);
  db.exec(`PRAGMA journal_mode = ${opts.journal ?? "WAL"};`);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  const schemaPath = join(__dirname, "schema.sql");
  const ddl = readFileSync(schemaPath, "utf8");
  db.exec(ddl);
}

/** 将行对象中的 0/1 转换成 boolean 字段 */
export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

export function jparse<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

export function jstr(v: unknown): string {
  return JSON.stringify(v ?? null);
}

export function nowText(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 金额（元字符串，兼容千分位/空格）→ 整数分 */
export function yuanToCents(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/[,\s￥¥元]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function centsToYuanStr(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** V2 同款文本标准化：去空白、全角括号、间隔号，小写 */
export function normalize(v: unknown): string {
  return String(v ?? "").replace(/[\s（）()·]/g, "").toLowerCase();
}

export function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 固定 T+1 候选日期：周一取周五六日，其他工作日取前一日 */
export function settlementBusinessDates(bankDate: string): string[] {
  const day = new Date(`${bankDate}T00:00:00Z`).getUTCDay();
  return day === 1
    ? [addDays(bankDate, -3), addDays(bankDate, -2), addDays(bankDate, -1)]
    : [addDays(bankDate, -1)];
}

export function roundFee(value: number, mode: string): number {
  return mode === "FLOOR" ? Math.floor(value) : mode === "CEIL" ? Math.ceil(value) : Math.round(value);
}

export function sha256Text(s: string): string {
  // 稳定的轻量哈希（非加密用途）：FNV-1a 64bit 的 hex 表示
  let h1 = 0xcbf29ce484222325n, h2 = 0x84222325cbf29ce4n;
  const fnv = (h: bigint, c: number) => {
    const bxor = h ^ BigInt(c);
    return (bxor * 0x100000001b3n) & 0xffffffffffffffffn;
  };
  for (let i = 0; i < s.length; i++) {
    h1 = fnv(h1, s.charCodeAt(i));
    h2 = fnv(h2, s.charCodeAt(i) + 0x5f);
  }
  return h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0");
}

/** ID 生成器：MG-0001 风格，进程内唯一递增 */
export class IdGen {
  private seq = 0;
  constructor(private db: DB) {
    const row = db.prepare("SELECT value FROM meta WHERE key='seq'").get() as { value: string } | undefined;
    this.seq = row ? Number(row.value) : 0;
  }
  next(prefix: string): string {
    this.seq += 1;
    const p = prefix.endsWith("-") ? prefix.slice(0, -1) : prefix;
    const id = `${p}-${String(this.seq).padStart(4, "0")}`;
    this.db.prepare("INSERT INTO meta(key,value) VALUES('seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(this.seq));
    return id;
  }
  peek(): number { return this.seq; }
}
