/* Connects the shared folder source to this dashboard.
   The published data/dashboard_data.json still loads first, so the page works
   exactly as before for anyone who has not chosen a folder. */

import { createFolderSource, rowsFromWorkbook } from "./folder-source.js";

const $ = (id) => document.getElementById(id);
const state = { publishedRows: null, requiredHeaders: [] };

function readPublished() {
  // app.js has already fetched and rendered; keep a copy to fall back to.
  const data = window.__dashboardState?.data || null;
  if (data) {
    state.publishedRows = data.rows || [];
    state.requiredHeaders = data.schema?.requiredHeaders || Object.keys(state.publishedRows[0] || {});
  }
}

function applyRows(rows, info) {
  const dash = window.__dashboardState;
  if (!dash) return;
  dash.rows = rows || state.publishedRows || [];
  dash.filtered = [...dash.rows];
  dash.page = 1;
  window.__dashboardRefresh?.();

  const badge = $("local-badge");
  if (rows && info?.fileName) {
    badge.hidden = false;
    badge.textContent = `${info.stale ? "Saved copy" : "Local file"}: ${info.fileName} · ${rows.length.toLocaleString()} rows`;
  } else {
    badge.hidden = true;
  }
  $("ls-forget").hidden = !rows;
}

// Reads only the first few rows, which is enough to see whether a workbook
// carries this dashboard's columns — quick even for a very large file.
async function looksLikeZoneWorkbook(file) {
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", sheetRows: 6, cellStyles: false });
    const wanted = state.requiredHeaders.map((h) => String(h).trim().toLowerCase());
    for (const sheetName of workbook.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", blankrows: false });
      for (const line of grid.slice(0, 5)) {
        const lower = line.map((c) => String(c).trim().toLowerCase());
        const hits = wanted.filter((h) => lower.includes(h)).length;
        if (hits >= Math.max(3, Math.ceil(wanted.length * 0.6))) return true;
      }
    }
  } catch { /* unreadable file - just skip it */ }
  return false;
}

const source = createFolderSource({
  id: "zone-distribution",
  // A folder shared by several dashboards will hold other exports too.
  filePattern: /zone|distribution|outlet/i,
  accepts: looksLikeZoneWorkbook,
  parse: async (file) => {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, cellStyles: false });
    const { rows, sheetName } = rowsFromWorkbook(workbook, state.requiredHeaders, XLSX);
    if (!rows.length) throw new Error(`"${sheetName}" has headers but no data rows.`);
    return rows;
  },
  onData: (rows, info) => applyRows(rows, info),
  onStatus: (s) => {
    const el = $("ls-state");
    const showGrant = s.kind === "needs-permission";
    $("ls-grant").hidden = !showGrant;
    const messages = {
      "no-folder": "Published data",
      "cached": `Saved copy of <b>${s.fileName || "local file"}</b>`,
      "reading": `Reading <b>${s.fileName}</b>${s.sizeMb ? ` (${s.sizeMb.toFixed(1)} MB)` : ""}…`,
      "live": `Live from <b>${s.fileName}</b>`,
      "empty": "Chosen folder has no Excel file",
      "no-match": `No workbook in that folder has this dashboard's columns${s.checked ? ` (checked ${s.checked})` : ""}`,
      "needs-permission": "Folder remembered — one click to reopen it",
      "unsupported": "This browser cannot open folders — use Chrome or Edge, or pick a single file",
      "error": `Could not read the folder: ${s.message || "unknown error"}`,
    };
    el.innerHTML = messages[s.kind] || s.kind;
  },
});

function boot() {
  readPublished();
  if (!state.requiredHeaders.length) { setTimeout(boot, 400); return; }
  source.start();
}

$("ls-pick").addEventListener("click", () => source.chooseFolder());
$("ls-grant").addEventListener("click", () => source.grantAccess());
$("ls-forget").addEventListener("click", () => source.forgetFolder());
$("ls-file-btn").addEventListener("click", () => $("ls-file").click());
$("ls-file").addEventListener("change", (e) => e.target.files[0] && source.useSingleFile(e.target.files[0]));

boot();
