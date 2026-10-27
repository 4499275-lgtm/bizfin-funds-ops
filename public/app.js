/* 业财一体资金运营平台 · 控制台逻辑（调用 /api/v1） */
const $ = (id) => document.getElementById(id);
const fmt = (cents) => `¥${((cents ?? 0) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (v) => String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
const tag = (text, tone) => `<span class="tag ${tone}">${esc(text)}</span>`;
const toneOf = (s) => s === "Closed" ? "green" : s === "Blocked" ? "red" : s === "Processing" ? "amber" : "gray";

function toast(text) {
  const el = $("msg"); el.textContent = text; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data ?? body;
}

async function loadAccounts() {
  const accounts = await api("/api/v1/accounts");
  $("accountSel").innerHTML = accounts.map(a =>
    `<option value="${esc(a.id)}">${esc(a.bank)} ${esc(a.accountName)}（${esc(a.maskedNo)}）</option>`).join("");
}

function ctx() { return { accountId: $("accountSel").value, reconDate: $("reconDate").value }; }

async function refresh() {
  const { accountId, reconDate } = ctx();
  if (!accountId) return;
  const [summary, stmts, excs, audits] = await Promise.all([
    api(`/api/v1/summary?accountId=${accountId}&reconDate=${reconDate}`),
    api(`/api/v1/bank-statements?accountId=${accountId}&reconDate=${reconDate}`),
    api(`/api/v1/exceptions?accountId=${accountId}`),
    api(`/api/v1/audit-events?limit=30`),
  ]);
  renderKpis(summary);
  renderStmts(stmts);
  renderExcs(excs.filter(e => e.status !== "CLOSED" || excs.indexOf(e) < 20));
  renderAudit(audits);
}

function renderKpis(s) {
  const b = s.byStatus || {};
  const kpi = (label, v, sub = "") => `<div class="kpi"><label>${label}</label><strong>${v}</strong><small>${sub}</small></div>`;
  $("kpis").innerHTML =
    kpi("收入流水", s.statements, esc(s.reconDate)) +
    kpi("Closed", b.Closed?.count ?? 0, fmt(b.Closed?.amountCents ?? 0)) +
    kpi("Blocked", b.Blocked?.count ?? 0, fmt(b.Blocked?.amountCents ?? 0)) +
    kpi("Processing", b.Processing?.count ?? 0, "") +
    kpi("开放异常", s.openExceptions, "需定位与路由") +
    kpi("业务订单", s.orders, "只读投影");
}

function renderStmts(rows) {
  $("stmtRows").innerHTML = rows.map(r => {
    const ident = r.identity
      ? `${r.identity.status === "IDENTIFIED" ? tag(r.identity.sourceType || "已识别", "blue") : tag("未识别", "red")}<div class="mono">${esc(r.identity.id)} V${r.identity.version}｜${esc(r.identity.ruleId || "—")}</div>`
      : tag("待评估", "gray");
    const dec = r.decision
      ? `${tag(`${r.decision.status}/${r.decision.coverage}`, r.decision.status === "CONFIRMED" ? "green" : r.decision.coverage === "PARTIAL" ? "amber" : "gray")}<div class="mono">${esc(r.decision.targetType)}:${esc((r.decision.targetIds || []).join("|")) || "—"}</div>`
      : "—";
    const exc = (r.exceptions || []).length
      ? r.exceptions.map(e => tag(e.type, "red")).join(" ")
      : tag("无", "gray");
    const trust = r.trusted ? `${tag(r.trusted.status, toneOf(r.trusted.status))}<div class="mono">${esc(r.trusted.id)} V${r.trusted.version}</div>` : tag("Processing", "amber");
    const alloc = r.identity && r.identity.status === "IDENTIFIED" && r.decision?.coverage !== "FULL"
      ? `<button class="small primary" onclick="openAlloc('${esc(r.id)}', ${r.amountCents}, '${esc((r.decision?.basis || "").slice(0, 60))}')">归属处理</button>` : "";
    return `<tr>
      <td><strong>${esc(r.bankSerialNo)}</strong></td>
      <td>${esc(r.payerName || "—")}<div class="mono">${esc(r.memo || "")}</div></td>
      <td class="money">${fmt(r.amountCents)}</td>
      <td>${ident}</td><td>${dec}</td><td>${exc}</td><td>${trust}</td>
      <td>${alloc}<button class="small" onclick="showTrail('${esc(r.id)}')">证据链</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="8">当前上下文没有流水</td></tr>`;
}

function renderExcs(rows) {
  $("excRows").innerHTML = rows.map(e => `<tr>
    <td class="mono">${esc(e.id)} V${e.version}</td>
    <td><strong>${esc(e.type)}</strong><div class="mono">${esc(e.ruleId)} V${e.ruleVersion}</div></td>
    <td class="mono">${esc((e.statementIds || []).join("、")) || "订单级"}</td>
    <td>${esc(e.location)}<div class="mono">责任：${esc(e.responsibility)}｜${esc(e.severity)}</div></td>
    <td>${tag(e.status, e.status === "DETECTED" ? "red" : e.status === "PROCESSING" ? "amber" : "gray")}</td>
    <td>${esc(e.route)}<div class="mono">${esc((e.basis || "").slice(0, 80))}</div></td>
    <td>
      ${e.status === "DETECTED" ? `<button class="small" onclick="acceptExc('${esc(e.id)}')">受理</button>` : ""}
      ${e.status !== "CLOSED" ? `<button class="small" onclick="closeExc('${esc(e.id)}')">关闭</button>` : ""}
    </td>
  </tr>`).join("") || `<tr><td colspan="7">没有异常记录</td></tr>`;
}

function renderAudit(rows) {
  $("auditRows").innerHTML = rows.map(a => `<tr>
    <td class="mono">${esc(a.ts)}</td><td>${tag(a.type, "blue")}</td>
    <td class="mono">${esc(a.object)}</td><td>${esc(a.message)}<div class="mono">${esc((a.details || "").slice(0, 100))}</div></td>
  </tr>`).join("");
}

/* ---- 动作 ---- */
async function runEval() {
  const { accountId, reconDate } = ctx();
  try {
    const r = await api("/api/v1/evaluations/run", { method: "POST", body: JSON.stringify({ accountId, reconDate }) });
    toast(`评估完成：${r.statementCount} 笔｜新增异常 ${r.exceptionsNew}｜关闭 ${r.exceptionsClosed}｜状态变化 ${r.trustedChanges}`);
    await refresh();
  } catch (e) { toast(`失败：${e.message}`); }
}

async function loadScene(scene) {
  try {
    const r = await api("/api/v1/demo/seed", { method: "POST", body: JSON.stringify({ scene }) });
    $("reconDate").value = r.reconDate;
    await loadAccounts();
    toast(`场景 ${scene} 已就绪：Closed ${r.evaluation.statementCount - 0}`);
    await refresh();
  } catch (e) { toast(`失败：${e.message}`); }
}

async function importBank(dry) {
  const file = $("bankFile").files[0];
  if (!file) { toast("请选择 CSV / XLSX 文件"); return; }
  const { accountId, reconDate } = ctx();
  const fd = new FormData();
  fd.append("accountId", accountId);
  fd.append("reconDate", reconDate);
  fd.append("dryRun", String(dry));
  fd.append("file", file);
  const res = await fetch("/api/v1/bank-statements/import", { method: "POST", body: fd });
  const body = await res.json();
  if (!res.ok || body.ok === false) { toast(`导入失败：${body.error || res.status}`); return; }
  const d = body.data;
  const c = d.counts;
  $("importResult").style.display = "block";
  $("importResult").innerHTML = dry
    ? `<strong>预览（未写入）</strong>：总行 ${d.totalRows}｜导入 ${c.IMPORTED}｜重复 ${c.DUPLICATE}｜支出 ${c.OUT_OF_SCOPE}｜失败 ${c.REJECTED}｜冲突 ${c.CONFLICT}`
    : `<strong>批次 ${esc(d.batchId)} 已导入</strong>：${d.imported} 笔｜重复 ${c.DUPLICATE}｜支出 ${c.OUT_OF_SCOPE}｜失败 ${c.REJECTED}｜冲突 ${c.CONFLICT}。新流水需运行四层评估。`;
  await refresh();
}

let allocTarget = null;
async function openAlloc(statementId, amountCents, basis) {
  allocTarget = statementId;
  const types = await api("/api/v1/non-receivable-types");
  $("allocNRT").innerHTML = `<option value="">不选择</option>` +
    types.filter(t => t.enabled).map(t => `<option value="${esc(t.id)}">${esc(t.name)}｜${esc(t.category)}${t.evidenceRequired ? "｜需凭据" : ""}</option>`).join("");
  $("allocInfo").innerHTML = `流水 <strong>${esc(statementId)}</strong>｜收入 ${fmt(amountCents)}｜当前依据：${esc(basis) || "—"}`;
  $("allocOrder").value = ""; $("allocAmount").value = ""; $("allocEvidence").value = "";
  $("allocDlg").showModal();
}

async function submitAlloc() {
  const orderId = $("allocOrder").value.trim();
  const amount = Number($("allocAmount").value);
  const nrt = $("allocNRT").value;
  const payload = { note: $("allocNote").value.trim(), evidence: $("allocEvidence").value.trim() };
  if (orderId) payload.orderAllocations = [{ orderId, amountCents: Math.round(amount * 100) }];
  else if (nrt) payload.nonReceivableTypeId = nrt;
  else { toast("请选择订单或无应收类型"); return; }
  try {
    const r = await api(`/api/v1/statements/${allocTarget}/allocate`, { method: "POST", body: JSON.stringify(payload) });
    $("allocDlg").close();
    toast(r.ok ? "归属决策已确认，可信状态已重评估" : "完成");
    await refresh();
  } catch (e) { toast(`失败：${e.message}`); }
}

async function acceptExc(id) {
  try { await api(`/api/v1/exceptions/${id}/accept`, { method: "POST" }); toast("异常进入处理中"); await refresh(); }
  catch (e) { toast(`失败：${e.message}`); }
}

async function closeExc(id) {
  const reason = prompt("关闭原因（必填）："); if (!reason) return;
  const evidence = prompt("关闭依据（函件/审批单/外部处理记录）：") || "人工关闭";
  try { await api(`/api/v1/exceptions/${id}/close`, { method: "POST", body: JSON.stringify({ reason, evidence }) }); toast("异常已关闭并重评估"); await refresh(); }
  catch (e) { toast(`失败：${e.message}`); }
}

async function showTrail(statementId) {
  const stmts = await api(`/api/v1/bank-statements?accountId=${ctx().accountId}&reconDate=${ctx().reconDate}`);
  const r = stmts.find(x => x.id === statementId);
  if (!r) return;
  const lines = [
    `银行流水 ${r.bankSerialNo}｜${fmt(r.amountCents)}｜${r.payerName || ""}`,
    `① 身份：${r.identity ? `${r.identity.id} V${r.identity.version} ${r.identity.status} ${r.identity.sourceType}（${r.identity.evidence}）` : "未评估"}`,
    `② 认领：${r.decision ? `${r.decision.id} V${r.decision.version} ${r.decision.status}/${r.decision.coverage} → ${r.decision.targetType}:${(r.decision.targetIds || []).join("|")}` : "未评估"}`,
    `③ 异常：${(r.exceptions || []).map(e => `${e.id} ${e.type}(${e.status})`).join("、") || "无"}`,
    `④ 可信状态：${r.trusted ? `${r.trusted.id} V${r.trusted.version} ${r.trusted.status}｜${r.trusted.basis}` : "未发布"}`,
  ];
  alert(lines.join("\n"));
}

/* ---- 导出 ---- */
function q() { const { accountId, reconDate } = ctx(); return `accountId=${accountId}&reconDate=${reconDate}`; }
function exportDaily() { window.open(`/api/v1/export/daily-report?${q()}&format=${$("exportFormat").value}`); }
function exportTrusted() { window.open(`/api/v1/export/trusted-status?${q()}`); }
function exportExceptions() { window.open(`/api/v1/export/exceptions?accountId=${ctx().accountId}&format=csv`); }
function exportGroups() { window.open(`/api/v1/export/match-groups?${q()}&format=csv`); }
function exportAudit() { window.open(`/api/v1/export/audit?limit=1000`); }

$("reconDate").addEventListener("change", refresh);
$("accountSel").addEventListener("change", refresh);
loadAccounts().then(refresh).catch(e => toast(`初始化失败：${e.message}`));
