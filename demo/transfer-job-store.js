/* Local interruption ledger; never stores provider credentials or full plans. */
(() => {
  const databaseName = 'music-importer-transfer-jobs';
  const databaseVersion = 1;
  const storeName = 'jobs';
  const maxJobs = 50;
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
      } : null,
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
    const record = normalizeJob({ ...job, status: 'in-progress', progress: null, outcome: '' });
    return record ? put(record) : false;
  }

  async function updateProgress(id, progress) {
    const key = String(id || '');
    const current = await get(key);
    if (!current || current.status !== 'in-progress') return false;
    const updated = normalizeJob({ ...current, progress });
    return updated ? put(updated) : false;
  }

  async function finish(id, status, outcome = '') {
    const key = String(id || '');
    const current = await get(key);
    if (!current) return false;
    const updated = normalizeJob({ ...current, status: String(status || 'unknown'), outcome, progress: current.progress });
    return updated ? put(updated) : false;
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
    return finish(id, 'acknowledged', 'Пользователь подтвердил сверку целевого аккаунта.');
  }

  window.MusicTransferJobStore = Object.freeze({ start, updateProgress, finish, latestUnresolved, acknowledge });
})();
