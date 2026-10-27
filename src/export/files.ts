import ExcelJS from "exceljs";

/** XLSX 读取：返回字符串矩阵（兼容 CSV 导入同一条链路） */
export async function readXlsxMatrix(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: true }, row => {
    const out: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) {
      const cell = row.getCell(c);
      let v: unknown = cell.value;
      if (v && typeof v === "object" && "richText" in (v as any)) {
        v = (v as any).richText.map((r: any) => r.text ?? "").join("");
      } else if (v && typeof v === "object" && "result" in (v as any)) {
        v = (v as any).result;
      } else if (v instanceof Date) {
        v = v.toISOString().slice(0, 10);
      }
      out.push(v == null ? "" : String(v).trim());
    }
    matrix.push(out);
  });
  return matrix;
}

/** XLSX 写出：matrix → Buffer */
export async function writeXlsx(sheets: Array<{ name: string; rows: (string | number)[][]; widths?: number[] }>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "bizfin-funds-ops";
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const row of s.rows) ws.addRow(row);
    if (s.rows.length) {
      const header = ws.getRow(1);
      header.font = { bold: true };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF2FA" } };
      ws.views = [{ state: "frozen", ySplit: 1 }];
    }
    const colCount = s.rows[0]?.length ?? 8;
    for (let i = 1; i <= colCount; i++) {
      ws.getColumn(i).width = s.widths?.[i - 1] ?? Math.max(12, Math.min(38, String(s.rows[0]?.[i - 1] ?? "").length * 2 + 6));
    }
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** RFC4180 CSV 解析（支持引号、转义引号、\r\n；仅支持 UTF-8 / UTF-8 BOM） */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

export function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map(r => r.map(csvEscape).join(",")).join("\r\n");
}
