const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function createIndexedDB() {
  const stores = new Map();
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      const records = new Map();
      stores.set(name, records);
      return { createIndex() {} };
    },
    transaction(name) {
      const records = stores.get(name);
      const transaction = {
        objectStore() {
          return {
            put(record) {
              records.set(record.id, structuredClone(record));
              queueMicrotask(() => transaction.oncomplete?.());
            },
            get(id) {
              const request = {};
              queueMicrotask(() => {
                request.result = structuredClone(records.get(id));
                request.onsuccess?.();
              });
              return request;
            },
            getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = [...records.values()].map((record) => structuredClone(record));
                request.onsuccess?.();
              });
              return request;
            },
            delete(id) {
              records.delete(id);
              queueMicrotask(() => transaction.oncomplete?.());
            },
          };
        },
      };
      return transaction;
    },
  };
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function loadStore(indexedDB = null) {
  const context = { window: { indexedDB }, Date, Object, Map, Promise, String, Number };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/transfer-job-store.js'), 'utf8'), context);
  return context.window.MusicTransferJobStore;
}

test('does not claim interruption protection when persistent storage is unavailable', async () => {
  const store = loadStore();
  assert.equal(await store.start({ id: 'job-1', sourceProvider: 'spotify', targetProvider: 'apple-music' }), false);
  assert.equal(await store.latestUnresolved(), null);
});

test('persists progress, leaves failed jobs unresolved, and clears them only after acknowledgement', async () => {
  const store = loadStore(createIndexedDB());
  assert.equal(await store.start({ id: 'job-2', sourceProvider: 'zvuk', targetProvider: 'apple-music', operationCount: 840, playlistCount: 13 }), true);
  assert.equal(await store.updateProgress('job-2', { phase: 'favorites', completed: 40, total: 80, message: 'Лайки Basil playlist: 40 из 80' }), true);
  assert.equal(await store.finish('job-2', 'partial_failure', 'Read-back не совпал.'), true);
  const unresolved = await store.latestUnresolved();
  assert.equal(unresolved.status, 'partial_failure');
  assert.equal(unresolved.operationCount, 840);
  assert.equal(unresolved.progress.phase, 'favorites');
  assert.equal(unresolved.progress.completed, 40);
  assert.equal('message' in unresolved.progress, false);
  assert.equal('plan' in unresolved, false);
  assert.equal(await store.acknowledge('job-2'), true);
  assert.equal(await store.latestUnresolved(), null);
});
