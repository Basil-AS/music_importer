const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function createIndexedDB({ legacyJobs = [] } = {}) {
  const stores = new Map();
  let version = legacyJobs.length ? 1 : 0;
  let planWrites = 0;
  let planDeletes = 0;
  if (version) stores.set('jobs', new Map(legacyJobs.map((job) => [job.id, structuredClone(job)])));

  const indexNames = (indexes = new Set()) => ({ contains: (name) => indexes.has(name) });
  const db = {
    get objectStoreNames() { return { contains: (name) => stores.has(name) }; },
    createObjectStore(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const indexes = new Set();
      return { indexNames: indexNames(indexes), createIndex(indexName) { indexes.add(indexName); } };
    },
    transaction(names) {
      const allowed = Array.isArray(names) ? names : [names];
      const transaction = {};
      transaction.objectStore = (name) => {
        if (!allowed.includes(name)) throw new Error(`Store ${name} is outside this transaction`);
        const records = stores.get(name);
        if (!records) throw new Error(`Missing store ${name}`);
        return {
          indexNames: indexNames(),
          createIndex() {},
          put(record) {
            records.set(record.id, structuredClone(record));
            if (name === 'recoveryPlans') planWrites += 1;
            setTimeout(() => transaction.oncomplete?.(), 0);
            return {};
          },
          get(id) {
            const request = {};
            queueMicrotask(() => {
              request.result = records.has(id) ? structuredClone(records.get(id)) : undefined;
              request.onsuccess?.();
              setTimeout(() => transaction.oncomplete?.(), 0);
            });
            return request;
          },
          getAll() {
            const request = {};
            queueMicrotask(() => {
              request.result = [...records.values()].map((record) => structuredClone(record));
              request.onsuccess?.();
              setTimeout(() => transaction.oncomplete?.(), 0);
            });
            return request;
          },
          delete(id) {
            records.delete(id);
            if (name === 'recoveryPlans') planDeletes += 1;
            setTimeout(() => transaction.oncomplete?.(), 0);
            return {};
          },
          openCursor() {
            const request = {};
            const entries = [...records.entries()];
            let position = 0;
            const emit = () => {
              const [key, value] = entries[position] || [];
              request.result = position < entries.length ? {
                key,
                value: structuredClone(value),
                update(nextValue) { records.set(key, structuredClone(nextValue)); },
                continue() { position += 1; queueMicrotask(emit); },
              } : null;
              request.onsuccess?.();
            };
            queueMicrotask(emit);
            return request;
          },
        };
      };
      return transaction;
    },
  };

  return {
    open(_name, requestedVersion) {
      const request = { result: db };
      const oldVersion = version;
      if (requestedVersion > version) {
        request.transaction = db.transaction(['jobs', 'recoveryPlans'], 'readwrite');
        version = requestedVersion;
        queueMicrotask(() => request.onupgradeneeded?.({ oldVersion, newVersion: version }));
      }
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
    get planWrites() { return planWrites; },
    get planDeletes() { return planDeletes; },
    readJob(id) { return structuredClone(stores.get('jobs')?.get(id)); },
    readPlan(id) { return structuredClone(stores.get('recoveryPlans')?.get(id)); },
  };
}

function loadStore(indexedDB = null) {
  const context = { window: { indexedDB, structuredClone }, Date, Object, Map, Promise, String, Number, JSON, setTimeout, console };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/transfer-job-store.js'), 'utf8'), context);
  return context.window.MusicTransferJobStore;
}

const recoveryPlan = { type: 'music-transfer-plan', operations: [{ target: { providerId: 'target-1' } }], collectionMappings: [{ sourceId: 'playlist-1' }] };

test('does not claim interruption protection when persistent storage is unavailable', async () => {
  const store = loadStore();
  assert.equal(await store.start({ id: 'job-1', sourceProvider: 'spotify', targetProvider: 'apple-music', recoveryPlan }), false);
  assert.equal(await store.latestUnresolved(), null);
});

test('progress checkpoints do not rewrite the recovery plan', async () => {
  const indexedDB = createIndexedDB();
  const store = loadStore(indexedDB);
  assert.equal(await store.start({ id: 'job-2', sourceProvider: 'zvuk', targetProvider: 'apple-music', operationCount: 840, playlistCount: 13, recoveryPlan }), true);
  assert.equal(indexedDB.planWrites, 1);
  assert.equal('recoveryPlan' in indexedDB.readJob('job-2'), false, 'large plan is stored separately from the frequently updated job');
  assert.equal(await store.resume('job-2'), false, 'an active recent job must not be claimed by a second app tab');
  assert.equal(await store.acknowledge('job-2'), false, 'an active recent job must not be cleared by another app tab');
  for (let completed = 1; completed <= 100; completed += 1) {
    assert.equal(await store.updateProgress('job-2', {
      phase: 'playlist-items', completed, total: 100, sourceKey: `playlist-${completed}`,
      targetPlaylistId: `apple-playlist-${completed}`, playlistIndex: completed - 1,
      message: 'Private playlist title',
    }), true);
  }
  assert.equal(indexedDB.planWrites, 1, '100 checkpoints must write the durable plan only once');
  assert.equal(await store.finish('job-2', 'partial_failure', 'Read-back не совпал.'), true);
  const unresolved = await store.latestUnresolved();
  assert.equal(unresolved.status, 'partial_failure');
  assert.equal(unresolved.operationCount, 840);
  assert.equal(unresolved.progress.phase, 'playlist-items');
  assert.equal(unresolved.progress.completed, 100);
  assert.equal(unresolved.progress.playlistIndex, 99);
  assert.equal('message' in unresolved.progress, false);
  assert.deepEqual(unresolved.recoveryPlan, recoveryPlan);
  assert.equal(unresolved.playlistTargets['playlist-100'], 'apple-playlist-100');
  assert.equal(await store.resume('job-2'), true);
  assert.equal((await store.latestUnresolved()).status, 'in-progress');
  assert.equal(await store.finish('job-2', 'partial_failure', 'Still needs review.'), true);
  assert.equal(await store.acknowledge('job-2'), true);
  assert.equal(indexedDB.planDeletes, 1);
  assert.equal(await store.latestUnresolved(), null);
});

test('migrates an existing version 1 inline plan to the separate recovery store', async () => {
  const legacyJob = {
    id: 'legacy-job', sourceProvider: 'zvuk', targetProvider: 'spotify', status: 'partial_failure',
    operationCount: 3, playlistCount: 1, updatedAt: new Date().toISOString(), recoveryPlan,
  };
  const indexedDB = createIndexedDB({ legacyJobs: [legacyJob] });
  const store = loadStore(indexedDB);
  const unresolved = await store.latestUnresolved();
  assert.deepEqual(unresolved.recoveryPlan, recoveryPlan);
  assert.equal(indexedDB.readJob('legacy-job').hasRecoveryPlan, true);
  assert.equal('recoveryPlan' in indexedDB.readJob('legacy-job'), false);
  assert.deepEqual(indexedDB.readPlan('legacy-job').recoveryPlan, recoveryPlan);
  assert.equal(await store.resume('legacy-job'), true);
});

test('refuses to start a durable transfer record without a recoverable plan', async () => {
  const store = loadStore(createIndexedDB());
  assert.equal(await store.start({ id: 'job-3', sourceProvider: 'spotify', targetProvider: 'apple-music' }), false);
});
