/* ═══════════════════════════════════════════════════════════════════════════
   folder-source.js — read the dashboard's Excel straight from a folder on this
   computer instead of uploading it to GitHub.

   Behaviour the dashboards share:
     • pick the folder once; it stays the default until you change it
     • reconnects on its own when the page opens
     • follows the folder live — replace the file and the numbers follow,
       delete it and the dashboard says so
     • keeps the last read locally, so the page shows data instantly and
       still works with no folder access at all

   Browser note: Chrome and Edge drop folder permission once every tab of a site
   is closed, and re-granting needs a click. That is a browser security rule, so
   one "Allow folder access" button appears after a restart; everything else is
   automatic.
   ═══════════════════════════════════════════════════════════════════════════ */

const DB_NAME = "dashboard-folder-source";
const DB_VER = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VER);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("handles")) db.createObjectStore("handles");
      if (!db.objectStoreNames.contains("cache")) db.createObjectStore("cache");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(store, key, value) {
  try {
    const db = await openDb();
    db.transaction(store, "readwrite").objectStore(store).put(value, key);
  } catch { /* storage unavailable - the dashboard still works, just without memory */ }
}

async function dbGet(store, key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function dbDelete(store, key) {
  try {
    const db = await openDb();
    db.transaction(store, "readwrite").objectStore(store).delete(key);
  } catch { /* nothing to clean up */ }
}

const fileSignature = (file) => `${file.name}|${file.lastModified}|${file.size}`;

/**
 * Every workbook in the folder, newest first. A date in the filename outranks the
 * modified time, so "…_2026-08-17.xlsx" beats a file merely touched later.
 *
 * All candidates are returned rather than just the newest, because a shared data
 * folder holds workbooks for several dashboards. Picking the newest file outright
 * makes a dashboard read another dashboard's export; the caller decides which
 * files it actually understands.
 */
async function candidateWorkbooks(handle) {
  const found = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== "file") continue;
    if (name.startsWith("~$") || !/\.xlsx$|\.xlsm$/i.test(name)) continue;
    const file = await entry.getFile();
    const matched = name.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
    found.push({ file, stamp: matched ? `${matched[1]}${matched[2]}${matched[3]}` : "", modified: file.lastModified });
  }
  found.sort((a, b) => (b.stamp.localeCompare(a.stamp)) || (b.modified - a.modified));
  return found.map((c) => c.file);
}

export function createFolderSource({
  id,                 // storage key, one per dashboard
  parse,              // async (File) -> payload for the dashboard
  onData,             // (payload, info) -> render it
  onStatus,           // (state) -> update the UI
  filePattern = null, // optional RegExp: a quick name check before opening a file
  accepts = null,     // async (File) -> boolean: does this workbook fit this dashboard?
  pollMs = 5000,
}) {
  const state = { handle: null, signature: "", fileName: "", savedAt: 0, stale: false, watching: false };

  const status = (kind, detail = {}) =>
    onStatus?.({ kind, fileName: state.fileName, savedAt: state.savedAt, stale: state.stale, ...detail });

  async function useFile(file, { cache = true, skipped = 0 } = {}) {
    status("reading", { fileName: file.name, sizeMb: file.size / 1048576 });
    await new Promise((r) => setTimeout(r, 20));   // let the status paint first
    const payload = await parse(file);
    state.signature = fileSignature(file);
    state.fileName = file.name;
    state.stale = false;
    if (cache) {
      await dbPut("cache", id, { payload, fileName: file.name, signature: state.signature, savedAt: Date.now() });
    }
    onData(payload, { fileName: file.name, stale: false });
    status("live", { skipped });
  }

  async function sync({ silent = true } = {}) {
    if (!state.handle) return;
    let permission = "denied";
    try { permission = await state.handle.queryPermission({ mode: "read" }); } catch { /* older browser */ }
    if (permission !== "granted") { status("needs-permission"); return; }

    try {
      const candidates = await candidateWorkbooks(state.handle);
      const named = filePattern ? candidates.filter((f) => filePattern.test(f.name)) : [];
      // Names that look right are tried first; otherwise every workbook is offered
      // to accepts() so a renamed export is still found.
      const ordered = [...named, ...candidates.filter((f) => !named.includes(f))];

      let chosen = null;
      let skipped = 0;
      for (const file of ordered) {
        if (!accepts) { chosen = file; break; }
        let ok = false;
        try { ok = await accepts(file); } catch { ok = false; }
        if (ok) { chosen = file; break; }
        skipped += 1;
      }

      if (!chosen) {
        if (state.signature || !silent) {
          state.signature = ""; state.fileName = "";
          await dbDelete("cache", id);
          onData(null, { fileName: "", stale: false });
          status(candidates.length ? "no-match" : "empty", { skipped, checked: candidates.length });
        }
        return;
      }
      if (fileSignature(chosen) !== state.signature) await useFile(chosen, { skipped });
      else status("live", { skipped });
    } catch (error) {
      if (!silent) status("error", { message: error.message });
    }
  }

  function watch() {
    if (state.watching) return;
    state.watching = true;
    setInterval(() => { if (!document.hidden) sync(); }, pollMs);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  }

  return {
    /** Restores the saved copy, then reconnects to the remembered folder. */
    async start() {
      const cached = await dbGet("cache", id);
      if (cached?.payload) {
        state.signature = cached.signature;
        state.fileName = cached.fileName;
        state.savedAt = cached.savedAt;
        state.stale = true;
        onData(cached.payload, { fileName: cached.fileName, stale: true, savedAt: cached.savedAt });
        status("cached");
      } else {
        status("no-folder");
      }
      const handle = await dbGet("handles", id);
      if (!handle) return;
      state.handle = handle;
      let permission = "prompt";
      try { permission = await handle.queryPermission({ mode: "read" }); } catch { /* ignore */ }
      if (permission === "granted") { await sync({ silent: false }); watch(); }
      else status("needs-permission");
    },

    /** Choose (or change) the default folder. */
    async chooseFolder() {
      if (!window.showDirectoryPicker) { status("unsupported"); return; }
      try {
        const handle = await window.showDirectoryPicker({ id: `folder-${id}`, mode: "read" });
        state.handle = handle;
        state.signature = "";
        await dbPut("handles", id, handle);
        await sync({ silent: false });
        watch();
      } catch (error) {
        if (error.name !== "AbortError") status("error", { message: error.message });
      }
    },

    /** One click after a browser restart, then automatic again. */
    async grantAccess() {
      if (!state.handle) return this.chooseFolder();
      try {
        if ((await state.handle.requestPermission({ mode: "read" })) === "granted") {
          state.signature = "";
          await sync({ silent: false });
          watch();
        }
      } catch (error) { status("error", { message: error.message }); }
    },

    /** Fallback for browsers without folder access. */
    async useSingleFile(file) {
      try { await useFile(file); }
      catch (error) { status("error", { message: error.message }); }
    },

    /** Back to the published data that ships with the site. */
    async forgetFolder() {
      state.handle = null; state.signature = ""; state.fileName = "";
      await dbDelete("handles", id);
      await dbDelete("cache", id);
      onData(null, { fileName: "", stale: false });
      status("no-folder");
    },
  };
}

/**
 * Finds the sheet whose header row carries the required headers and returns its
 * rows as objects — the same shape scripts/build.py writes into
 * data/dashboard_data.json, so the dashboard cannot tell the difference.
 */
export function rowsFromWorkbook(workbook, requiredHeaders, XLSX) {
  const wanted = requiredHeaders.map((h) => String(h).trim().toLowerCase());
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", blankrows: false });
    for (let headerRow = 0; headerRow < Math.min(grid.length, 15); headerRow += 1) {
      const headers = grid[headerRow].map((h) => String(h).trim());
      const lower = headers.map((h) => h.toLowerCase());
      const hits = wanted.filter((h) => lower.includes(h)).length;
      if (hits < Math.max(3, Math.ceil(wanted.length * 0.6))) continue;
      const rows = [];
      for (let r = headerRow + 1; r < grid.length; r += 1) {
        const line = grid[r];
        if (!line || line.every((cell) => String(cell).trim() === "")) continue;
        const row = {};
        headers.forEach((header, c) => { if (header) row[header] = line[c] ?? ""; });
        rows.push(row);
      }
      return { rows, sheetName, headerRow: headerRow + 1, matchedHeaders: hits };
    }
  }
  throw new Error("No sheet in that workbook carries the expected column headers.");
}
