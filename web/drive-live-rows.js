/* drive-live-rows.js
   After the published data/dashboard_data.json has rendered, check whether
   this browser already has an authorized Google Drive connection (the same
   one used for the "Google Drive Live" badge in the header). If so, look
   through the connected folder for the workbook that carries this
   dashboard's required headers — any filename, whichever file actually
   matches — parse it client-side, and swap its rows in over the published
   data.

   Silent by design, on purpose: no popups, no consent prompts here. If
   Drive isn't connected yet, the saved access token has expired, or nothing
   in the folder matches this dashboard's columns, the published data that
   app.js already rendered is simply left as-is. Re-authorizing (if needed)
   happens through the existing "Connect Google Drive" button, not here. */

(async function () {
  const $ = (id) => document.getElementById(id);
  const MAX_CANDIDATE_BYTES = 15 * 1024 * 1024; // guards against scanning huge unrelated exports (Z-Report, audit responses, etc.) that live in the same shared folder
  const NAME_HINT = /zone|distribution|outlet/i;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-drive-live-dep="${src}"]`)) { resolve(); return; }
      const script = document.createElement("script");
      script.src = src;
      script.dataset.driveLiveDep = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    });
  }

  function waitFor(check, timeoutMs = 15000, intervalMs = 100) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (check()) { resolve(); return; }
        if (Date.now() - start > timeoutMs) { reject(new Error("Timed out waiting for the dashboard to be ready.")); return; }
        setTimeout(poll, intervalMs);
      })();
    });
  }

  function normKey(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  // Mirrors scripts/build.py's excel_serial_to_iso() so a date column reads
  // the same way whether the site was built from GitHub or read live here.
  function excelSerialToIso(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Number(text) * 86400000);
      if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
    }
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (isoMatch) return isoMatch[0];
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return text;
  }

  // Re-keys a rowsFromWorkbook() row onto the schema's canonical header
  // spelling/casing, and converts numeric/date columns the same way
  // scripts/build.py does — so a Drive file with slightly different header
  // casing or spacing still lines up with every column the table expects.
  function normalizeRow(raw, headerLookup, numericCols, dateCols) {
    const row = {};
    for (const [key, value] of Object.entries(raw)) {
      const canon = headerLookup.get(normKey(key));
      if (!canon) continue;
      if (dateCols.has(canon)) {
        row[canon] = excelSerialToIso(value);
      } else if (numericCols.has(canon)) {
        const text = String(value ?? "").trim();
        if (text === "") { row[canon] = null; }
        else { const num = Number(text); row[canon] = Number.isFinite(num) ? num : text; }
      } else {
        row[canon] = String(value ?? "").trim();
      }
    }
    return row;
  }

  try {
    await waitFor(() => window.__zoneDashboard?.state?.data);

    const drive = window.ShwapnoDrive;
    if (!drive) return;
    const info = drive.describe();
    if (!info.authorized || !info.folder) return; // not connected right now — published data stands as-is

    const dash = window.__zoneDashboard;
    const schema = dash.state.data?.schema || {};
    const requiredHeaders = schema.requiredHeaders || [];
    if (!requiredHeaders.length) return;
    const numericCols = new Set(schema.numericColumns || []);
    const dateCols = new Set(schema.dateColumns || []);
    const headerLookup = new Map(requiredHeaders.map((h) => [normKey(h), h]));

    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
    await waitFor(() => window.XLSX, 15000);
    const { rowsFromWorkbook } = await import(`./folder-source.js?v=drive-live-rows-v1`);

    const files = await drive.listFolderFiles(info.folder.id);
    const candidates = files.filter((f) =>
      /\.xlsx$|\.xlsm$/i.test(f.name || "") && Number(f.size || 0) <= MAX_CANDIDATE_BYTES
    );
    // Files whose name hints at this dashboard are tried first (cheap win in
    // the common case); everything else is still tried, in case the export
    // was renamed or dated for the month, so content is what actually decides.
    const named = candidates.filter((f) => NAME_HINT.test(f.name || ""));
    const rest = candidates.filter((f) => !named.includes(f));
    const byNewest = (a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0);
    named.sort(byNewest);
    rest.sort(byNewest);
    const ordered = [...named, ...rest];

    let matchedRows = null;
    let matchedFile = null;
    for (const meta of ordered) {
      let file;
      try { file = await drive.downloadFile(meta); } catch { continue; }
      let workbook;
      try { workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, cellStyles: false }); }
      catch { continue; }
      let result;
      try { result = rowsFromWorkbook(workbook, requiredHeaders, window.XLSX); }
      catch { continue; }
      if (result?.rows?.length) { matchedRows = result.rows; matchedFile = meta; break; }
    }
    if (!matchedRows) return; // nothing in the folder carries this dashboard's columns right now

    const finalRows = matchedRows.map((raw) => normalizeRow(raw, headerLookup, numericCols, dateCols));

    const dashState = dash.state;
    dashState.rows = finalRows;
    dashState.filtered = [...finalRows];
    dashState.page = 1;
    dash.refreshFilters();
    dash.applyFilters();

    const key = schema.uniqueKey || "CODE";
    const codes = finalRows.map((r) => String(r[key] || "").trim());
    const nonBlank = codes.filter(Boolean);
    const duplicateCodes = nonBlank.length - new Set(nonBlank).size;
    const blankCodes = codes.length - nonBlank.length;

    const sourceBadge = $("source-badge");
    if (sourceBadge) {
      sourceBadge.textContent = `${finalRows.length.toLocaleString()} rows · live from Google Drive`;
      sourceBadge.title = `Source file: ${matchedFile.name}\nFolder: ${info.folder.name}`;
    }
    const qualityBadge = $("quality-badge");
    if (qualityBadge) {
      const quality = duplicateCodes + blankCodes;
      qualityBadge.textContent = quality === 0
        ? "Data check: codes clean"
        : `Data check: ${duplicateCodes} duplicate · ${blankCodes} blank codes`;
      qualityBadge.style.background = quality ? "rgba(215,25,32,.18)" : "";
    }
  } catch (error) {
    console.warn("Live Google Drive row refresh skipped:", error?.message || error);
  }
})();
