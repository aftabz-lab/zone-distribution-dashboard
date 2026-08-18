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

const source = createFolderSource({
  id: "zone-distribution",
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
      "empty": "Chosen folder has no matching Excel file",
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
