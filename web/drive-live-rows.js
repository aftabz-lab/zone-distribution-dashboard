/* drive-live-rows.js
   After data/dashboard_data.json has rendered, load the latest validated
   Zone snapshot published by the unattended Google Drive worker. This is the
   primary cross-device source and does not depend on a browser OAuth token.

   If this browser also has the Drive folder connected, check it for a newer
   schema-matching workbook and swap those rows in as an optional live
   override. A browser Drive error must never erase or replace the published
   cloud rows.

   The saved folder persists indefinitely, but the OAuth access token used
   to call the Drive API expires after about an hour. Page load must never
   request a replacement token because Google Identity Services can turn
   even a nominally silent request into an account chooser. Re-authorizing
   therefore happens only through the existing user-clicked
   "Connect Google Drive" button.

   Status is reported on the source badge at each stage, on success or
   failure alike, so what happened is visible on the page itself rather than
   only in the console. */

(async function () {
  const $ = (id) => document.getElementById(id);
  const MAX_CANDIDATE_BYTES = 15 * 1024 * 1024; // guards against scanning huge unrelated exports (Z-Report, audit responses, etc.) that live in the same shared folder
  const NAME_HINT = /zone|distribution|outlet/i;
  const SAVED_SNAPSHOT_KEY = "shwapno-zone-last-good-snapshot-v1";
  const LEGACY_HEADERS = {code:"CODE",name:"Outlet Name",zonal:"Zonal",format:"Format",leader:"Leader",status:"Status",district:"District",division:"Division",area:"Area",location:"Location Type"};
  let cloudApplied = false;
  let cloudStatusText = "";
  let cloudStatusTitle = "";

  function setStatus(text, title) {
    const badge = $("source-badge");
    if (!badge) return;
    badge.textContent = text;
    if (title) badge.title = title;
  }

  function keepCloudStatus(driveNote = "") {
    if (!cloudApplied) return false;
    setStatus(
      cloudStatusText,
      [cloudStatusTitle, driveNote ? `Browser Drive refresh: ${driveNote}` : ""].filter(Boolean).join("\n")
    );
    return true;
  }

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

  function withTimeout(promise, timeoutMs, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message || "Timed out")), timeoutMs)),
    ]);
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
      const canon = headerLookup.get(normKey(key)) || LEGACY_HEADERS[normKey(key)];
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

    const dash = window.__zoneDashboard;
    const schema = dash.state.data?.schema || {};
    const requiredHeaders = schema.requiredHeaders || [];
    if (!requiredHeaders.length) return;
    const numericCols = new Set(schema.numericColumns || []);
    const dateCols = new Set(schema.dateColumns || []);
    const headerLookup = new Map(requiredHeaders.map((h) => [normKey(h), h]));

    function applyDashboardRows(rawRows, snapshot = null) {
      const previousByCode = new Map(dash.state.rows.map(row => [String(row.CODE || "").trim(), row]));
      const finalRows = rawRows.map((raw, index) => {
        const normalized = normalizeRow(raw, headerLookup, numericCols, dateCols);
        const previous = previousByCode.get(String(normalized.CODE || "").trim());
        if (snapshot?.legacyCompact && !previous) throw new Error("The compact snapshot contains a new outlet; waiting for its complete workbook snapshot.");
        // Compact snapshots omit SFT, dates, contacts and other workbook fields.
        // Retain those actual fields by outlet code instead of blanking them.
        const row = snapshot?.legacyCompact ? { ...previous, ...normalized, SL: index + 1 } : normalized;
        requiredHeaders.forEach((header) => {
          if (!(header in row)) row[header] = numericCols.has(header) ? null : "";
        });
        return row;
      });
      if (!finalRows.length) throw new Error("The snapshot contains no data rows.");

      const dashState = dash.state;
      dashState.rows = finalRows;
      dashState.data.rows = finalRows;
      if (snapshot) dashState.data.meta = {
        ...dashState.data.meta,
        rowCount: finalRows.length,
        sourceWorkbook: snapshot.fileName || dashState.data.meta?.sourceWorkbook,
        sourceWorksheet: snapshot.sheetName || dashState.data.meta?.sourceWorksheet,
        savedAt: snapshot.savedAt || snapshot.cloudUpdatedAt,
        generatedAt: snapshot.savedAt || snapshot.cloudUpdatedAt || dashState.data.meta?.generatedAt,
      };
      dashState.filtered = [...finalRows];
      dashState.page = 1;
      dash.refreshFilters();
      dash.applyFilters();

      const key = schema.uniqueKey || "CODE";
      const codes = finalRows.map((row) => String(row[key] || "").trim());
      const nonBlank = codes.filter(Boolean);
      const duplicateCodes = nonBlank.length - new Set(nonBlank).size;
      const blankCodes = codes.length - nonBlank.length;
      const qualityBadge = $("quality-badge");
      if (qualityBadge) {
        const quality = duplicateCodes + blankCodes;
        qualityBadge.textContent = quality === 0
          ? "Data check: codes clean"
          : `Data check: ${duplicateCodes} duplicate · ${blankCodes} blank codes`;
        qualityBadge.style.background = quality ? "rgba(215,25,32,.18)" : "";
      }
      return finalRows;
    }

    function validateSnapshot(snapshot) {
      if (!snapshot?.rows?.length) return false;
      if (snapshot.legacyCompact) return true;
      return snapshot.rows.every(row => {
        const keys = new Set(Object.keys(row || {}).map(normKey));
        return requiredHeaders.every(header => keys.has(normKey(header)));
      });
    }

    let appliedIdentity = "";
    let appliedTime = Date.parse(dash.state.data.meta?.savedAt || dash.state.data.meta?.generatedAt || "") || 0;
    function applySnapshot(snapshot, cached = false) {
      if (!validateSnapshot(snapshot)) throw new Error("The published Zone snapshot does not match the current 26-column schema.");
      const snapshotTime = Date.parse(snapshot.cloudUpdatedAt || snapshot.savedAt || "") || 0;
      if (snapshotTime && snapshotTime < appliedTime) return;
      const identity = [snapshot.fileSignature, snapshot.cloudUpdatedAt || snapshot.savedAt, snapshot.fileName, snapshot.rows.length].join("|");
      if (identity === appliedIdentity) return;
      const finalRows = applyDashboardRows(snapshot.rows, snapshot);
      appliedIdentity = identity;
      appliedTime = Math.max(appliedTime, snapshotTime);
      cloudApplied = true;
      cloudStatusText = `${finalRows.length.toLocaleString()} rows · ${cached ? "saved Drive snapshot" : "published Drive snapshot"}`;
      cloudStatusTitle = [
        `Source file: ${snapshot.fileName || "Zone Distribution snapshot"}`,
        snapshot.sheetName ? `Worksheet: ${snapshot.sheetName}` : "",
        snapshot.savedAt ? `Snapshot: ${snapshot.savedAt}` : "",
      ].filter(Boolean).join("\n");
      setStatus(cloudStatusText, cloudStatusTitle);
      try { localStorage.setItem(SAVED_SNAPSHOT_KEY, JSON.stringify({ ...snapshot, rows: finalRows, legacyCompact: false })); } catch {}
    }

    // Restore complete validated data immediately; OAuth expiry cannot remove it.
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_SNAPSHOT_KEY) || "null");
      if (validateSnapshot(saved)) applySnapshot(saved, true);
    } catch {}

    let refreshPromise = null;
    let retryTimer = null;
    async function refreshCloud() {
      if (refreshPromise) return refreshPromise;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      refreshPromise = (async () => { try {
      const { readZoneSnapshot } = await import(`./cloud-snapshot.js?v=zone-auto-data-v36-20261012`);
      const snapshot = await withTimeout(readZoneSnapshot(), 15000, "Loading the published Zone snapshot timed out");
      if (snapshot?.rows?.length) {
        applySnapshot(snapshot);
      } else throw new Error("No complete Zone snapshot has been published yet.");
    } catch (error) {
      console.warn("Published Zone snapshot unavailable:", error?.message || error);
      retryTimer = setTimeout(refreshCloud, 60000);
    } })();
      try { await refreshPromise; } finally { refreshPromise = null; }
    }

    // Reuse the existing portal snapshot clock; the worker's snapshot rules stay
    // unchanged and full data is downloaded only when that clock changes.
    const snapshotClock = document.querySelector('[data-snapshot-key="zone-distribution"]');
    if (snapshotClock) {
      let clockText = snapshotClock.textContent;
      new MutationObserver(() => {
        const value = snapshotClock.textContent;
        if (value !== clockText) { clockText = value; refreshCloud(); }
      }).observe(snapshotClock, { childList: true, characterData: true, subtree: true });
    }
    window.addEventListener("online", refreshCloud);
    window.addEventListener("focus", refreshCloud);
    await refreshCloud();

    const drive = window.ShwapnoDrive;
    if (!drive) return;
    const info = drive.describe();
    if (!info.folder) return; // cloud/static published data stands as-is

    if (!info.authorized) {
      // Never call requestToken() during page load. It can open Google's
      // account chooser without a user gesture. The cloud snapshot is the
      // normal source; the existing button handles any optional reconnect.
      if (!keepCloudStatus("optional browser refresh is disconnected; use Connect Google Drive manually")) {
        setStatus("Published data (Drive sign-in optional — use Connect Google Drive)");
      }
      return;
    }

    setStatus("Reading Google Drive folder…");
    await withTimeout(loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"), 15000, "Loading the Excel reader library timed out");
    await waitFor(() => window.XLSX, 15000);
    const { rowsFromWorkbook } = await import(`./folder-source.js?v=drive-live-rows-v2`);

    const files = await withTimeout(drive.listFolderFiles(info.folder.id), 20000, "Listing the Drive folder timed out");
    const candidates = files.filter((file) =>
      /\.xlsx$|\.xlsm$/i.test(file.name || "") && Number(file.size || 0) <= MAX_CANDIDATE_BYTES
    );
    if (!candidates.length) {
      if (!keepCloudStatus("no Excel file under 15 MB was found")) {
        setStatus("Published data (no Excel file under 15 MB found in the Drive folder)");
      }
      return;
    }
    // Files whose name hints at this dashboard are tried first; content still
    // decides, so a renamed workbook remains supported.
    const named = candidates.filter((file) => NAME_HINT.test(file.name || ""));
    const rest = candidates.filter((file) => !named.includes(file));
    const byNewest = (a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0);
    named.sort(byNewest);
    rest.sort(byNewest);
    const ordered = [...named, ...rest];

    let matchedRows = null;
    let matchedFile = null;
    let lastError = "";
    for (const meta of ordered) {
      let file;
      try { file = await withTimeout(drive.downloadFile(meta), 30000, "Download timed out"); }
      catch (error) { lastError = `Could not download "${meta.name}": ${error?.message || error}`; continue; }
      let workbook;
      try { workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, cellStyles: false }); }
      catch (error) { lastError = `Could not read "${meta.name}": ${error?.message || error}`; continue; }
      let result;
      try { result = rowsFromWorkbook(workbook, requiredHeaders, window.XLSX); }
      catch (error) { lastError = `"${meta.name}": ${error?.message || error}`; continue; }
      if (result?.rows?.length) { matchedRows = result.rows; matchedFile = meta; break; }
    }
    if (!matchedRows) {
      if (!keepCloudStatus(`${candidates.length} Excel file${candidates.length === 1 ? " was" : "s were"} checked; none matched`)) {
        setStatus(
          `Published data (${candidates.length} Excel file${candidates.length === 1 ? "" : "s"} checked in Drive, none matched this dashboard's columns)`,
          lastError || undefined
        );
      }
      return;
    }

    const liveSnapshot = { fileName: matchedFile.name, savedAt: new Date().toISOString(), rows: matchedRows };
    const finalRows = applyDashboardRows(matchedRows, liveSnapshot);
    try { localStorage.setItem(SAVED_SNAPSHOT_KEY, JSON.stringify({ ...liveSnapshot, rows: finalRows, legacyCompact: false })); } catch {}
    setStatus(
      `${finalRows.length.toLocaleString()} rows · live from Google Drive`,
      `Source file: ${matchedFile.name}\nFolder: ${info.folder.name}`
    );
  } catch (error) {
    if (!keepCloudStatus(error?.message || String(error))) {
      setStatus("Published data (live Drive refresh hit an error)", error?.message || String(error));
    }
    console.warn("Live Google Drive row refresh skipped:", error?.message || error);
  }
})();

