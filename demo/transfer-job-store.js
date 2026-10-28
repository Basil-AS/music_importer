/* Local interruption ledger. Recovery plans may contain private track metadata, never credentials. */
(() => {
  const databaseName = 'music-importer-transfer-jobs';
  const databaseVersion = 2;
  const jobsStoreName = 'jobs';
  const recoveryPlansStoreName = 'recoveryPlans';
  const maxJobs = 50;
  const terminalSafeStatuses = new Set(['complete', 'acknowledged']);
  let databasePromise;

  function isRecoveryPlan(plan) {
    return plan?.type === 'music-transfer-plan'
      && Array.isArray(plan.operations)
      && Array.isArray(plan.collectionMappings);
  }

  function cloneRecoveryPlan(plan) {
    if (!isRecoveryPlan(plan)) return null;
    try {
      return JSON.parse(JSON.stringify(plan));
    } catch { return null; }
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      let request;
      try { request = window.indexedDB.open(databaseName, databaseVersion); }
      catch { return resolve(null); }
      request.onupgradeneeded = (event) => {
        const db = request.result;
        let jobs;
        if (!db.objectStoreNames.contains(jobsStoreName)) {
          jobs = db.createObjectStore(jobsStoreName, { keyPath: 'id' });
        } else {
          jobs = request.transaction.objectStore(jobsStoreName);
        }
        if (!jobs.indexNames.contains('updatedAt')) jobs.createIndex('updatedAt', 'updatedAt');
        if (!jobs.indexNames.contains('status')) jobs.createIndex('status', 'status');
        if (!db.objectStoreNames.contains(recoveryPlansStoreName)) {
          db.createObjectStore(recoveryPlansStoreName, { keyPath: 'id' });
        }

        // Version 1 stored the potentially large plan inline. Move it during the
        // versionchange transaction so no interrupted migration can lose a job.
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          const cursorRequest = jobs.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const record = cursor.value;
            const recoveryPlan = cloneRecoveryPlan(record.recoveryPlan);
            const migrated = { ...record, hasRecoveryPlan: Boolean(recoveryPlan) };
            delete migrated.recoveryPlan;
            if (recoveryPlan) {
              request.transaction.objectStore(recoveryPlansStoreName).put({ id: record.id, recoveryPlan });
            }
            cursor.update(migrated);
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  }

  function normalizeJob(job) {
    if (!job?.id || !job?.sourceProvider || !job?.targetProvider) return null;
    const playlistTargets = {};
    if (job.playlistTargets && typeof job.playlistTargets === 'object') {
      for (const [sourceKey, targetId] of Object.entries(job.playlistTargets)) {
        const key = String(sourceKey).slice(0, 500);
        const id = String(targetId || '').slice(0, 300);
        if (key && id) playlistTargets[key] = id;
      }
    }
    const hasRecoveryPlan = typeof job.hasRecoveryPlan === 'boolean'
      ? job.hasRecoveryPlan
      : isRecoveryPlan(job.recoveryPlan);
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
      hasRecoveryPlan,
      playlistTargets,
      outcome: String(job.outcome || '').slice(0, 300),
    };
  }

  function transaction(db, storeNames, mode, operation) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeNames, mode);
        operation(tx);
      } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async function putJob(record) {
    const db = await openDatabase();
    if (!db) return false;
    try {
      await transaction(db, jobsStoreName, 'readwrite', (tx) => tx.objectStore(jobsStoreName).put(record));
      void prune(db);
      return true;
    } catch { return false; }
  }

  async function putJobAndPlan(record, recoveryPlan) {
    const db = await openDatabase();
    if (!db) return false;
    try {
      await transaction(db, [jobsStoreName, recoveryPlansStoreName], 'readwrite', (tx) => {
        tx.objectStore(recoveryPlansStoreName).put({ id: record.id, recoveryPlan });
        tx.objectStore(jobsStoreName).put(record);
      });
      void prune(db);
      return true;
    } catch { return false; }
  }

  async function putJobAndDeletePlan(record) {
    const db = await openDatabase();
    if (!db) return false;
    try {
      await transaction(db, [jobsStoreName, recoveryPlansStoreName], 'readwrite', (tx) => {
        tx.objectStore(jobsStoreName).put(record);
        tx.objectStore(recoveryPlansStoreName).delete(record.id);
      });
      void prune(db);
      return true;
    } catch { return false; }
  }

  async function prune(db) {
    try {
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(jobsStoreName, 'readonly');
        const request = tx.objectStore(jobsStoreName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      const safe = records.filter((record) => terminalSafeStatuses.has(record.status))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      const keep = new Set(safe.slice(0, maxJobs).map((record) => record.id));
      const remove = records.filter((record) => terminalSafeStatuses.has(record.status) && !keep.has(record.id));
      if (!remove.length) return;
      await transaction(db, [jobsStoreName, recoveryPlansStoreName], 'readwrite', (tx) => {
        const jobs = tx.objectStore(jobsStoreName);
        const plans = tx.objectStore(recoveryPlansStoreName);
        remove.forEach((record) => {
          jobs.delete(record.id);
          plans.delete(record.id);
        });
      });
    } catch { /* History cleanup must not interrupt an active transfer. */ }
  }

  async function start(job) {
    const recoveryPlan = cloneRecoveryPlan(job?.recoveryPlan);
    if (!recoveryPlan) return false;
    const record = normalizeJob({ ...job, hasRecoveryPlan: true, status: 'in-progress', progress: null, playlistTargets: {}, outcome: '' });
    return record ? putJobAndPlan(record, recoveryPlan) : false;
  }

  async function getJob(id) {
    const db = await openDatabase();
    if (!db) return null;
    return new Promise((resolve) => {
      let tx;
      try { tx = db.transaction(jobsStoreName, 'readonly'); }
      catch { return resolve(null); }
      const request = tx.objectStore(jobsStoreName).get(String(id || ''));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async function updateProgress(id, progress) {
    const current = await getJob(id);
    if (!current || current.status !== 'in-progress') return false;
    const playlistTargets = { ...current.playlistTargets };
    if (progress?.sourceKey && progress?.targetPlaylistId) {
      playlistTargets[String(progress.sourceKey).slice(0, 500)] = String(progress.targetPlaylistId).slice(0, 300);
    }
    const updated = normalizeJob({ ...current, progress, playlistTargets });
    return updated ? putJob(updated) : false;
  }

  async function finish(id, status, outcome = '') {
    const current = await getJob(id);
    if (!current) return false;
    const nextStatus = String(status || 'unknown');
    const clearsPlan = terminalSafeStatuses.has(nextStatus);
    const updated = normalizeJob({
      ...current,
      status: nextStatus,
      outcome,
      progress: current.progress,
      hasRecoveryPlan: clearsPlan ? false : current.hasRecoveryPlan,
      playlistTargets: clearsPlan ? {} : current.playlistTargets,
    });
    if (!updated) return false;
    return clearsPlan ? putJobAndDeletePlan(updated) : putJob(updated);
  }

  async function mutateExisting(id, predicate, update) {
    const db = await openDatabase();
    if (!db) return false;
    const key = String(id || '');
    return new Promise((resolve) => {
      let tx;
      let changed = false;
      try { tx = db.transaction([jobsStoreName, recoveryPlansStoreName], 'readwrite'); }
      catch { return resolve(false); }
      const jobs = tx.objectStore(jobsStoreName);
      const plans = tx.objectStore(recoveryPlansStoreName);
      tx.oncomplete = () => resolve(changed);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
      const request = jobs.get(key);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || !predicate(current)) return;
        const updated = normalizeJob(update(current));
        if (!updated) return;
        jobs.put(updated);
        if (!updated.hasRecoveryPlan) plans.delete(key);
        changed = true;
      };
      request.onerror = () => resolve(false);
    });
  }

  async function resume(id) {
    return mutateExisting(id, (current) => Boolean(current.hasRecoveryPlan)
      && !terminalSafeStatuses.has(current.status)
      && (current.status !== 'in-progress' || Date.now() - Date.parse(current.updatedAt) >= 5 * 60 * 1000),
    (current) => ({ ...current, status: 'in-progress', outcome: '' }));
  }

  async function latestUnresolved() {
    const db = await openDatabase();
    if (!db) return null;
    let records = [];
    try {
      records = await new Promise((resolve, reject) => {
        const tx = db.transaction(jobsStoreName, 'readonly');
        const request = tx.objectStore(jobsStoreName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
    const latest = records.filter((record) => !terminalSafeStatuses.has(record.status))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
    if (!latest) return null;
    if (!latest.hasRecoveryPlan) return { ...latest, recoveryPlan: null };
    try {
      const recoveryPlan = await new Promise((resolve) => {
        const tx = db.transaction(recoveryPlansStoreName, 'readonly');
        const request = tx.objectStore(recoveryPlansStoreName).get(latest.id);
        request.onsuccess = () => resolve(request.result?.recoveryPlan || null);
        request.onerror = () => resolve(null);
      });
      return { ...latest, recoveryPlan };
    } catch { return { ...latest, recoveryPlan: null }; }
  }

  async function acknowledge(id) {
    return mutateExisting(id, (current) => current.status !== 'complete'
      && current.status !== 'acknowledged'
      && (current.status !== 'in-progress' || Date.now() - Date.parse(current.updatedAt) >= 5 * 60 * 1000),
    (current) => ({
      ...current,
      status: 'acknowledged',
      outcome: 'Пользователь подтвердил сверку целевого аккаунта.',
      hasRecoveryPlan: false,
      playlistTargets: {},
    }));
  }

  window.MusicTransferJobStore = Object.freeze({ start, updateProgress, finish, resume, latestUnresolved, acknowledge });
})();
