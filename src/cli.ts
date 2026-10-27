import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { openDb, IdGen, nowText } from "./core/db.js";
import { AppService } from "./core/service.js";
import { parseCsv, readXlsxMatrix } from "./export/files.js";
import {
  dailyReportCsv, dailyReportXlsx, exceptionsCsv, exceptionsXlsx,
  trustedStatusPayload, writeFileSyncSafe,
} from "./export/cliExport.js";
import { buildServer } from "./api/server.js";

const USAGE = `bizfin-funds-ops CLI — 业财一体资金运营平台
用法:
  node dist/cli.js init --db <file>                     初始化数据库（主数据+规则）
  node dist/cli.js seed-demo --db <file> --scene flower|property   导入演示场景并运行四层
  node dist/cli.js import-bank --db <file> --account <id> --date YYYY-MM-DD --file <csv|xlsx> [--dry-run]
  node dist/cli.js import-orders --db <file> --source <sys> --file <csv|xlsx>
  node dist/cli.js run --db <file> --account <id> --date YYYY-MM-DD [--statements id1,id2]
  node dist/cli.js export --db <file> --type trusted|daily|exceptions|groups --account <id> --date <d> --format json|csv|xlsx --out <file>
  node dist/cli.js token-add --db <file> --name <name> --role read|write|admin
  node dist/cli.js webhook-add --db <file> --url <url> --secret <s> --events "*"
  node dist/cli.js serve --db <file> [--port 8787] [--host 0.0.0.0]
`;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) { console.error(`缺少 --${name}`); process.exit(2); }
  return v;
}
async function loadMatrix(file: string): Promise<string[][]> {
  const data = readFileSync(file);
  return file.toLowerCase().endsWith(".csv") ? parseCsv(data.toString("utf8")) : await readXlsxMatrix(data);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); return; }
  const dbFile = arg("db", "data/funds.db")!;

  if (cmd === "serve") {
    const db = openDb({ file: dbFile });
    const app = await buildServer({ db, port: Number(arg("port", "8787")), host: arg("host", "0.0.0.0") });
    const tokens = db.prepare(`SELECT COUNT(*) n FROM api_tokens`).get() as any;
    await app.listen({ port: Number(arg("port", "8787")), host: arg("host", "0.0.0.0") });
    console.log(`✓ 服务已启动 http://localhost:${arg("port", "8787")}  数据库: ${resolve(dbFile)}`);
    if (!tokens.n) console.warn("⚠ 未配置 API Token，当前为 open 模式（仅限开发/演示）。请运行 token-add 后重启。");
    return;
  }

  if (cmd === "init") {
    const db = openDb({ file: dbFile });
    const svc = new AppService(db, "cli");
    svc.ensureSeeded();
    console.log(`✓ 数据库已初始化: ${resolve(dbFile)}`);
    return;
  }

  const svc = AppService.open(dbFile, "cli");
  svc.ensureSeeded();

  if (cmd === "seed-demo") {
    const scene = (arg("scene", "flower") === "property" ? "property" : "flower") as "flower" | "property";
    const out = svc.seedScene(scene);
    const sum = svc.summary(out.accountId, out.reconDate);
    console.log(`✓ 场景 ${scene} 已导入并评估: account=${out.accountId} date=${out.reconDate}`);
    console.log(`  评估批次 ${out.evaluation.evaluationId}｜状态分布 ${JSON.stringify(sum.byStatus)}｜开放异常 ${sum.openExceptions}`);
    return;
  }

  if (cmd === "import-bank") {
    const accountId = need("account"), date = need("date"), file = need("file");
    const dryRun = process.argv.includes("--dry-run");
    const matrix = await loadMatrix(file);
    const preview = svc.previewBankImport({ accountId, reconDate: date, fileName: basename(file), matrix });
    console.log(`预览: 总行 ${preview.totalRows}`, JSON.stringify(preview.counts));
    if (dryRun) {
      for (const r of preview.rows.filter(r => r.validationStatus !== "IMPORTED")) {
        console.log(`  行${r.rowNo} ${r.bankSerialNo} -> ${r.validationStatus} ${r.errorCodes.join("/")}`);
      }
      return;
    }
    const out = svc.confirmBankImport(preview, matrix);
    console.log(`✓ 批次 ${out.batchId} 导入 ${out.imported} 笔`);
    return;
  }

  if (cmd === "import-orders") {
    const source = need("source"), file = need("file");
    const matrix = await loadMatrix(file);
    const header = matrix[0];
    const col = (names: string[]) => header.findIndex(h => names.includes(String(h).trim()));
    const idx = {
      external: col(["来源订单ID"]), orderNo: col(["业务订单号"]), customerCode: col(["客户编号"]),
      customerName: col(["客户名称"]), amount: col(["订单金额(元)"]), status: col(["支付状态"]),
      pc: col(["支付公司"]), paidAt: col(["支付成功时间"]), bizDate: col(["业务日期"]), updatedAt: col(["上游更新时间"]),
    };
    const orders = matrix.slice(1).filter(r => r.some(c => c.trim() !== "")).map(r => ({
      externalOrderId: r[idx.external] ?? "", orderNo: r[idx.orderNo] ?? "", customerCode: idx.customerCode >= 0 ? r[idx.customerCode] : undefined,
      customerName: r[idx.customerName] ?? "", amountCents: Math.round(Number(r[idx.amount] ?? 0) * 100),
      paymentStatus: r[idx.status] ?? "", paymentCompanyId: idx.pc >= 0 ? r[idx.pc] || undefined : undefined,
      paymentSuccessDate: idx.paidAt >= 0 ? (r[idx.paidAt] || "").slice(0, 10) || undefined : undefined,
      businessDate: r[idx.bizDate] ?? "", upstreamUpdatedAt: r[idx.updatedAt] ?? "",
    }));
    const res = svc.syncOrders(source, orders, "文件导入");
    console.log(`✓ 同步 ${res.received} 笔: 新增 ${res.inserted}｜更新 ${res.updated}｜重复 ${res.duplicate}｜拒绝 ${res.rejected}｜隔离 ${res.quarantined}`);
    return;
  }

  if (cmd === "run") {
    const accountId = need("account"), date = need("date");
    const ids = arg("statements")?.split(",").filter(Boolean);
    const res = svc.runEvaluation(accountId, date, ids, "cli");
    console.log(`✓ 评估批次 ${res.evaluationId}: ${res.statementCount} 笔｜新增异常 ${res.exceptionsNew}｜关闭异常 ${res.exceptionsClosed}｜状态变化 ${res.trustedChanges}`);
    const sum = svc.summary(accountId, date);
    console.log(`  状态分布 ${JSON.stringify(sum.byStatus)}`);
    return;
  }

  if (cmd === "export") {
    const type = need("type"), out = need("out");
    const format = arg("format", out.endsWith(".xlsx") ? "xlsx" : out.endsWith(".json") ? "json" : "csv")!;
    const accountId = arg("account") ?? "";
    const date = arg("date") ?? "";
    if (type === "trusted") {
      if (format === "json") writeFileSyncSafe(out, JSON.stringify(trustedStatusPayload(svc.db, accountId, date), null, 2));
      else if (format === "xlsx") { const buf = await dailyReportXlsx(svc.db, accountId, date); writeFileSyncSafe(out, buf); }
      else writeFileSyncSafe(out, dailyReportCsv(svc.db, accountId, date));
    } else if (type === "daily") {
      if (format === "xlsx") { const buf = await dailyReportXlsx(svc.db, accountId, date); writeFileSyncSafe(out, buf); }
      else writeFileSyncSafe(out, dailyReportCsv(svc.db, accountId, date));
    } else if (type === "exceptions") {
      if (format === "xlsx") { const buf = await exceptionsXlsx(svc.db, accountId || undefined); writeFileSyncSafe(out, buf); }
      else writeFileSyncSafe(out, exceptionsCsv(svc.db, accountId || undefined));
    } else {
      console.error(`未知导出类型 ${type}（trusted|daily|exceptions|groups）`);
      process.exit(2);
    }
    console.log(`✓ 已导出 ${resolve(out)}`);
    return;
  }

  if (cmd === "token-add") {
    const name = need("name"), role = arg("role", "write")!;
    const token = arg("token") ?? `bfo_${randomBytes(24).toString("hex")}`;
    svc.addToken(name, role, token);
    console.log(`✓ Token 已创建（仅显示一次）:\n  ${token}`);
    return;
  }

  if (cmd === "webhook-add") {
    const url = need("url"), secret = need("secret");
    const events = (arg("events", "*") ?? "*").split(",");
    const id = svc.addWebhook(url, secret, events);
    console.log(`✓ Webhook ${id} 已创建: ${url} events=${events.join(",")}`);
    return;
  }

  console.error(`未知命令 ${cmd}\n${USAGE}`);
  process.exit(2);
  void existsSync; void nowText; void IdGen;
}

main().catch(e => { console.error(e); process.exit(1); });
