/* Local interruption ledger. Recovery plans may contain private track metadata, never credentials. */
(() => {
  const databaseName = 'music-importer-transfer-jobs';
  const databaseVersion = 1;
  const storeName = 'jobs';
  const maxJobs = 50;
  const maxRecoveryPlanBytes = 20 * 1024 * 1024;
  const terminalSafeStatuses = new Set(['complete', 'acknowledged']);
  let databasePromise;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      let request;
      try { request = window.indexedDB.open(databaseName, databaseVersion); }
      catch { return resolve(null); }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('status', 'status');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  }

  function normalizeJob(job) {
    if (!job?.id || !job?.sourceProvider || !job?.targetProvider) return null;
    let recoveryPlan = null;
    if (job.recoveryPlan?.type === 'music-transfer-plan'
      && Array.isArray(job.recoveryPlan.operations)
      && Array.isArray(job.recoveryPlan.collectionMappings)) {
      try {
        const serialized = JSON.stringify(job.recoveryPlan);
        const bytes = window.TextEncoder ? new window.TextEncoder().encode(serialized).length : serialized.length * 3;
        if (bytes <= maxRecoveryPlanBytes) recoveryPlan = JSON.parse(serialized);
      } catch { /* Invalid or oversized plans cannot be resumed safely. */ }
    }
    const playlistTargets = {};
    if (job.playlistTargets && typeof job.playlistTargets === 'object') {
      for (const [sourceKey, targetId] of Object.entries(job.playlistTargets).slice(0, 500)) {
        const key = String(sourceKey).slice(0, 500);
        const id = String(targetId || '').slice(0, 300);
        if (key && id) playlistTargets[key] = id;
      }
    }
    return {
      id: String(job.id),
      sourceProvider: String(job.sourceProvider),
      targetProvider: String(job.targetProvider),
      operationCount: Math.max(0, Number(job.operationCount) || 0),
      playlistCount: Math.max(0, Number(job.playlistCount) || 0),
      startedAt: String(job.startedAt || new Date().toISOString()),
      updatedAt: new Date().toISOString(),
      status: String(job.status || 'in-progress'),
      progress: job.progress && typeof job.progress === 'object' ? {
        phase: String(job.progress.phase || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40),
        completed: job.progress.completed != null && Number.isFinite(Number(job.progress.completed)) ? Number(job.progress.completed) : null,
        total: job.progress.total != null && Number.isFinite(Number(job.progress.total)) ? Number(job.progress.total) : null,
        sourceKey: job.progress.sourceKey ? String(job.progress.sourceKey).slice(0, 500) : null,
        targetPlaylistId: job.progress.targetPlaylistId ? String(job.progress.targetPlaylistId).slice(0, 300) : null,
        playlistIndex: job.progress.playlistIndex != null && Number.isInteger(Number(job.progress.playlistIndex)) ? Number(job.progress.playlistIndex) : null,
      } : null,
      recoveryPlan,
      playlistTargets,
      outcome: String(job.outcome || '').slice(0, 300),
    };
  }

  async function put(record) {
    const db = await openDatabase();
    // A memory-only fallback would appear to protect the user while losing the
    // checkpoint on reload. Refuse to start a write unless it is durable.
    if (!db) return false;
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        transaction.objectStore(storeName).put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      void prune(db);
      return true;
    } catch { return false; }
  }

  async function prune(db) {
    try {
      const records = await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      const safe = records.filter((record) => terminalSafeStatuses.has(record.status))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      const keep = new Set(safe.slice(0, maxJobs).map((record) => record.id));
      const remove = records.filter((record) => terminalSafeStatuses.has(record.status) && !keep.has(record.id));
      if (!remove.length) return;
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        remove.forEach((record) => store.delete(record.id));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch { /* History cleanup must not interrupt an active transfer. */ }
  }

  async function start(job) {
    const record = normalizeJob({ ...job, status: 'in-progress', progress: null, playlistTargets: {}, outcome: '' });
    if (!record?.recoveryPlan) return false;
    return record ? put(record) : false;
  }

  async function updateProgress(id, progress) {
    const key = String(id || '');
    const current = await get(key);
    if (!current || current.status !== 'in-progress') return false;
    const playlistTargets = { ...current.playlistTargets };
    if (progress?.sourceKey && progress?.targetPlaylistId) {
      playlistTargets[String(progress.sourceKey).slice(0, 500)] = String(progress.targetPlaylistId).slice(0, 300);
    }
    const updated = normalizeJob({ ...current, progress, playlistTargets });
    return updated ? put(updated) : false;
  }

  async function finish(id, status, outcome = '') {
    const key = String(id || '');
    const current = await get(key);
    if (!current) return false;
    const nextStatus = String(status || 'unknown');
    const updated = normalizeJob({
      ...current,
      status: nextStatus,
      outcome,
      progress: current.progress,
      recoveryPlan: nextStatus === 'complete' || nextStatus === 'acknowledged' ? null : current.recoveryPlan,
      playlistTargets: nextStatus === 'complete' || nextStatus === 'acknowledged' ? {} : current.playlistTargets,
    });
    return updated ? put(updated) : false;
  }

  async function mutateExisting(id, predicate, update) {
    const db = await openDatabase();
    if (!db) return false;
    const key = String(id || '');
    return new Promise((resolve) => {
      let transaction;
      let changed = false;
      try { transaction = db.transaction(storeName, 'readwrite'); }
      catch { return resolve(false); }
      const store = transaction.objectStore(storeName);
      transaction.oncomplete = () => resolve(changed);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || !predicate(current)) return resolve(false);
        const updated = normalizeJob(update(current));
        if (!updated) return resolve(false);
        store.put(updated);
        changed = true;
      };
      request.onerror = () => resolve(false);
    });
  }

  async function resume(id) {
    return mutateExisting(id, (current) => Boolean(current.recoveryPlan)
      && !terminalSafeStatuses.has(current.status)
      && (current.status !== 'in-progress' || Date.now() - Date.parse(current.updatedAt) >= 5 * 60 * 1000),
    (current) => ({ ...current, status: 'in-progress', outcome: '' }));
  }

  async function get(id) {
    const key = String(id || '');
    const db = await openDatabase();
    if (!db) return null;
    return new Promise((resolve) => {
      let transaction;
      try { transaction = db.transaction(storeName, 'readonly'); }
      catch { return resolve(null); }
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async function latestUnresolved() {
    const db = await openDatabase();
    if (!db) return null;
    let records = [];
    try {
      records = await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
    return records.filter((record) => !terminalSafeStatuses.has(record.status))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] || null;
  }

  async function acknowledge(id) {
    return mutateExisting(id, (current) => current.status !== 'complete'
      && current.status !== 'acknowledged'
      && (current.status !== 'in-progress' || Date.now() - Date.parse(current.updatedAt) >= 5 * 60 * 1000),
    (current) => ({
      ...current,
      status: 'acknowledged',
      outcome: 'Пользователь подтвердил сверку целевого аккаунта.',
      recoveryPlan: null,
      playlistTargets: {},
    }));
  }

  window.MusicTransferJobStore = Object.freeze({ start, updateProgress, finish, resume, latestUnresolved, acknowledge });
})();
