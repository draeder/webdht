const DB_NAME = 'webdht';
const DB_VERSION = 1;

const QUOTA_LEVELS = {
  low: 1 * 1024 * 1024, // 1 MiB
  normal: 10 * 1024 * 1024, // 10 MiB
  high: 50 * 1024 * 1024, // 50 MiB
};

const QUOTA_STORAGE_KEY = 'webdht.idbQuotaLevel';

export const IDB_STORES = {
  DHT: 'dht-storage',
  UI: 'ui-storage',
};

let dbPromise = null;

function canUseIndexedDb() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function canUseLocalStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

function readQuotaLevel() {
  if (!canUseLocalStorage()) return 'normal';
  const level = String(localStorage.getItem(QUOTA_STORAGE_KEY) || 'normal');
  return level in QUOTA_LEVELS ? level : 'normal';
}

export function setQuotaLevel(level) {
  const safe = String(level || 'normal');
  const normalized = safe in QUOTA_LEVELS ? safe : 'normal';
  if (canUseLocalStorage()) {
    localStorage.setItem(QUOTA_STORAGE_KEY, normalized);
  }
  return normalized;
}

export function getQuotaLevel() {
  return readQuotaLevel();
}

export function getQuotaBytes() {
  const level = readQuotaLevel();
  return QUOTA_LEVELS[level] ?? QUOTA_LEVELS.normal;
}

function estimateSizeBytes(value) {
  try {
    const str = JSON.stringify(value);
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).byteLength;
    }
    return str.length;
  } catch {
    return 0;
  }
}

async function enforceStoreQuota(storeName) {
  const quotaBytes = getQuotaBytes();
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return;

  const db = await openWebdhtDb();
  if (!db) return;

  // Read all records and evict oldest-by-timestamp until under quota.
  const all = await idbGetAll(storeName);
  if (!Array.isArray(all) || all.length === 0) return;

  const rows = all
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      key: typeof r.key === 'string' ? r.key : null,
      timestamp: typeof r.timestamp === 'number' ? r.timestamp : 0,
      size: estimateSizeBytes(r),
    }))
    .filter((r) => typeof r.key === 'string' && r.key.length > 0);

  let total = rows.reduce((sum, r) => sum + (r.size || 0), 0);
  if (total <= quotaBytes) return;

  rows.sort((a, b) => a.timestamp - b.timestamp);

  for (const row of rows) {
    if (total <= quotaBytes) break;
    await idbDelete(storeName, row.key);
    total -= row.size || 0;
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function isIndexedDbAvailable() {
  return canUseIndexedDb();
}

export async function openWebdhtDb() {
  if (!canUseIndexedDb()) return null;
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      for (const storeName of Object.values(IDB_STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

export async function idbGetAll(storeName) {
  const db = await openWebdhtDb();
  if (!db) return [];
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const req = store.getAll();
  return requestToPromise(req);
}

export async function idbSet(storeName, key, value) {
  const db = await openWebdhtDb();
  if (!db) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  const req = store.put(value, key);
  await requestToPromise(req);

  // Best-effort quota enforcement.
  try {
    await enforceStoreQuota(storeName);
  } catch {
    // ignore
  }
}

export async function idbDelete(storeName, key) {
  const db = await openWebdhtDb();
  if (!db) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  const req = store.delete(key);
  await requestToPromise(req);
}
