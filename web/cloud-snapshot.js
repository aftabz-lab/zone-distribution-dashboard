const SNAPSHOT_FORMAT_VERSION = 1;
const ZREPORT_ROOT_KEY = "zreport";
const ZONE_ROOT_KEY = "zone-distribution";
const ZREPORT_CHUNK_TARGET = 450_000;
const chunkCache = new Map();

const syncApiPromise = import("./supabase-sync.js?v=shared-dashboard-cloud-v1");

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTime(...values) {
  return Math.max(0, ...values.map(timestamp));
}

function publicZoneSnapshot(snapshot) {
  return {
    version: Number(snapshot?.version || 5),
    sourceKind: "shared-cloud",
    fileName: String(snapshot?.fileName || "Zone Distribution snapshot"),
    fileSignature: String(snapshot?.fileSignature || ""),
    sheetName: String(snapshot?.sheetName || ""),
    columns: Array.isArray(snapshot?.columns) ? snapshot.columns : [],
    rows: Array.isArray(snapshot?.rows) ? snapshot.rows : [],
    savedAt: snapshot?.savedAt || new Date().toISOString(),
    diagnostics: snapshot?.diagnostics || {},
  };
}

export async function readZoneSnapshot() {
  const api = await syncApiPromise;
  const row = await api.readCloudSnapshot(ZONE_ROOT_KEY);
  const payload = row?.payload;
  const snapshot = payload?.snapshot;
  if (payload?.format !== "zone-snapshot-v1" || !Array.isArray(snapshot?.rows) || !snapshot.rows.length) return null;
  return {
    ...snapshot,
    sourceKind: "shared-cloud",
    savedAt: snapshot.savedAt || payload.generatedAt || row.updated_at,
    cloudUpdatedAt: row.updated_at || payload.generatedAt || snapshot.savedAt || null,
  };
}

export async function publishZoneSnapshot(snapshot) {
  if (!Array.isArray(snapshot?.rows) || !snapshot.rows.length || snapshot.sourceKind === "shared-cloud") {
    return { published: false, reason: "invalid-or-shared" };
  }
  const api = await syncApiPromise;
  if (!api.getPublisherSession()) return { published: false, reason: "publisher-login-required" };

  const current = await api.readCloudSnapshot(ZONE_ROOT_KEY).catch(() => null);
  const currentPayload = current?.payload;
  if (currentPayload?.fileSignature && currentPayload.fileSignature === snapshot.fileSignature &&
      newestTime(currentPayload.generatedAt, current?.updated_at) >= timestamp(snapshot.savedAt)) {
    return { published: false, reason: "unchanged" };
  }

  const shared = publicZoneSnapshot(snapshot);
  await api.publishCloudSnapshot(ZONE_ROOT_KEY, {
    version: SNAPSHOT_FORMAT_VERSION,
    format: "zone-snapshot-v1",
    generatedAt: shared.savedAt,
    fileSignature: shared.fileSignature,
    snapshot: shared,
  });
  return { published: true, savedAt: shared.savedAt };
}

function splitOutletEntries(outlets) {
  const parts = [];
  const codeParts = {};
  let entries = [];
  let estimatedBytes = 0;

  for (const [code, outlet] of Object.entries(outlets || {})) {
    const pair = [code, outlet];
    const pairBytes = JSON.stringify(pair).length + 1;
    if (entries.length && estimatedBytes + pairBytes > ZREPORT_CHUNK_TARGET) {
      parts.push(entries);
      entries = [];
      estimatedBytes = 0;
    }
    codeParts[code] = parts.length;
    entries.push(pair);
    estimatedBytes += pairBytes;
  }
  if (entries.length) parts.push(entries);
  return { parts, codeParts };
}

function partKey(bank, part) {
  return `zreport-${bank}-${String(part).padStart(3, "0")}`;
}

export async function readZReportSnapshot() {
  const api = await syncApiPromise;
  const row = await api.readCloudSnapshot(ZREPORT_ROOT_KEY);
  const payload = row?.payload;
  if (payload?.format !== "zreport-chunked-v1" || !payload?.index?.outlets?.length ||
      !payload?.bank || !Number.isInteger(payload?.partCount) || !payload.partCount || !payload?.codeParts) {
    return null;
  }
  return {
    index: payload.index,
    remoteSignature: payload.remoteSignature || "",
    savedAt: payload.generatedAt || row.updated_at || null,
    cloudUpdatedAt: row.updated_at || payload.generatedAt || null,
    sourceKind: "shared-cloud",
    cloud: {
      format: payload.format,
      bank: payload.bank,
      partCount: payload.partCount,
      codeParts: payload.codeParts,
      generatedAt: payload.generatedAt || row.updated_at || null,
    },
  };
}

export async function readZReportOutlet(cloud, code) {
  if (!cloud?.bank || !cloud?.codeParts || !(code in cloud.codeParts)) return null;
  const part = Number(cloud.codeParts[code]);
  if (!Number.isInteger(part) || part < 0 || part >= Number(cloud.partCount || 0)) return null;
  const key = partKey(cloud.bank, part);
  let payload = chunkCache.get(key);
  if (!payload) {
    const api = await syncApiPromise;
    const row = await api.readCloudSnapshot(key);
    payload = row?.payload;
    if (payload?.format !== "zreport-outlets-v1" || payload.bank !== cloud.bank ||
        Number(payload.part) !== part || !Array.isArray(payload.entries)) return null;
    chunkCache.set(key, payload);
  }
  const pair = payload.entries.find(entry => Array.isArray(entry) && entry[0] === code);
  return pair?.[1] || null;
}

export async function publishZReportSnapshot(snapshot) {
  if (!snapshot?.index?.outlets?.length || !snapshot?.outlets || snapshot.sourceKind === "shared-cloud") {
    return { published: false, reason: "invalid-or-shared" };
  }
  const api = await syncApiPromise;
  if (!api.getPublisherSession()) return { published: false, reason: "publisher-login-required" };

  const current = await api.readCloudSnapshot(ZREPORT_ROOT_KEY).catch(() => null);
  const currentPayload = current?.payload;
  if (currentPayload?.remoteSignature && currentPayload.remoteSignature === snapshot.remoteSignature &&
      newestTime(currentPayload.generatedAt, current?.updated_at) >= timestamp(snapshot.savedAt)) {
    return { published: false, reason: "unchanged" };
  }

  const bank = currentPayload?.bank === "a" ? "b" : "a";
  const { parts, codeParts } = splitOutletEntries(snapshot.outlets);
  if (!parts.length) return { published: false, reason: "no-outlets" };

  for (let part = 0; part < parts.length; part += 1) {
    await api.publishCloudSnapshot(partKey(bank, part), {
      version: SNAPSHOT_FORMAT_VERSION,
      format: "zreport-outlets-v1",
      bank,
      part,
      generatedAt: snapshot.savedAt,
      entries: parts[part],
    });
  }

  // Publish the manifest last. Readers therefore continue using the previous
  // complete bank until every chunk in the new bank is safely available.
  await api.publishCloudSnapshot(ZREPORT_ROOT_KEY, {
    version: SNAPSHOT_FORMAT_VERSION,
    format: "zreport-chunked-v1",
    bank,
    partCount: parts.length,
    codeParts,
    generatedAt: snapshot.savedAt,
    remoteSignature: snapshot.remoteSignature || "",
    index: snapshot.index,
  });
  chunkCache.clear();
  return { published: true, savedAt: snapshot.savedAt, parts: parts.length };
}
