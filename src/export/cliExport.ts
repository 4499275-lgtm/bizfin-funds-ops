import { writeFileSync } from "node:fs";
import { trustedStatusPayload } from "./reports.js";
import { dailyReportCsv, dailyReportXlsx, exceptionsCsv, exceptionsXlsx } from "./reports.js";
import type { DB } from "../core/db.js";

export { trustedStatusPayload, dailyReportCsv, dailyReportXlsx, exceptionsCsv, exceptionsXlsx };

export function writeFileSyncSafe(path: string, data: string | Buffer): void {
  writeFileSync(path, data);
}

void (undefined as unknown as DB);
