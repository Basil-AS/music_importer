const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function load() {
  const context = { window: {}, Date, Map, Set, Object, Array, Number, Math, Infinity: Infinity };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/library-cache.js'), 'utf8'), context);
  return context.window.MusicLibraryCache;
}

const hour = 60 * 60 * 1000;
const now = Date.parse('2026-10-29T12:00:00Z');
const snapshot = (overrides = {}) => ({
  exportedAt: new Date(now - hour).toISOString(),
  snapshotCachedAt: new Date(now - hour).toISOString(),
  completeness: { confirmed: true },
  collections: [
    { type: 'favorites', id: null, itemCount: 100, revision: 8, completeness: { confirmed: true }, items: [] },
    { type: 'playlists', id: 'p1', itemCount: 10, revision: 4, completeness: { confirmed: true }, items: [] },
    { type: 'albums', id: null, itemCount: 5, fingerprint: 'albums-v1', completeness: { confirmed: true }, items: [] },
  ],
  ...overrides,
});

test('evaluate distinguishes missing, fresh, check and stale snapshots', () => {
  const cache = load();
  assert.equal(cache.evaluate({ now }), 'missing');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot(), lastCheckedAt: new Date(now - 60000).toISOString(), now }), 'fresh');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot(), lastCheckedAt: new Date(now - 7 * hour).toISOString(), now }), 'check');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot({ completeness: { confirmed: false } }), now }), 'stale');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot({ exportedAt: new Date(now - 8 * 24 * hour).toISOString() }), now }), 'stale');
});

test('diffAgainstPulse re-reads only changed, new or unconfirmed collections', () => {
  const cache = load();
  const summary = cache.summarizeSnapshot(snapshot());
  const same = cache.diffAgainstPulse(summary, { complete: true, collections: [
    { type: 'favorites', id: null, itemCount: 100, revision: 8 }, { type: 'playlists', id: 'p1', itemCount: 10, revision: 4 }, { type: 'albums', id: null, itemCount: 5, fingerprint: 'albums-v1' },
  ] });
  assert.equal(same.unchanged, true);
  assert.equal(same.verified, true);
  const changed = cache.diffAgainstPulse(summary, { complete: true, collections: [
    { type: 'favorites', id: null, itemCount: 101, revision: 9 }, { type: 'playlists', id: 'p1', itemCount: 10, revision: 5 }, { type: 'playlists', id: 'p2', itemCount: 3, revision: 1 },
  ] });
  assert.deepEqual([...changed.reread].sort(), ['favorites:', 'playlists:p1', 'playlists:p2']);
  assert.deepEqual([...changed.removed], ['albums:']);
});

test('incomplete pulses cannot claim unchanged collections or remove omitted collections', () => {
  const cache = load();
  const summary = cache.summarizeSnapshot(snapshot());
  const result = cache.diffAgainstPulse(summary, { complete: false, collections: [] });
  assert.equal(result.verified, false);
  assert.equal(result.unchanged, false);
  assert.deepEqual([...result.reread].sort(), ['albums:', 'favorites:', 'playlists:p1']);
  assert.deepEqual([...result.removed], []);
});

test('count-only pulses trigger rereads because equal counts do not prove unchanged items', () => {
  const cache = load();
  const result = cache.diffAgainstPulse(cache.summarizeSnapshot(snapshot()), { complete: true, collections: [
    { type: 'favorites', id: null, itemCount: 100 },
    { type: 'playlists', id: 'p1', itemCount: 10, revision: 4 },
    { type: 'albums', id: null, itemCount: 5, fingerprint: 'albums-v1' },
  ] });
  assert.deepEqual([...result.reread], ['favorites:']);
  assert.deepEqual([...result.removed], []);
});

test('mergeSnapshots keeps the old confirmed copy when a re-read is unconfirmed', () => {
  const cache = load();
  const merged = cache.mergeSnapshots(snapshot(), [
    { type: 'favorites', id: null, itemCount: 101, completeness: { confirmed: false }, items: [] },
    { type: 'playlists', id: 'p2', itemCount: 3, completeness: { confirmed: true }, items: [] },
  ], { removedKeys: ['albums:'], now: now });
  const byKey = Object.fromEntries(merged.collections.map((collection) => [cache.collectionKey(collection), collection]));
  assert.equal(byKey['favorites:'].itemCount, 100);
  assert.ok(byKey['playlists:p2']);
  assert.ok(byKey['albums:'], 'an omitted collection is retained unless its catalog pulse is complete');
  assert.equal(merged.completeness.confirmed, true);
  assert.equal(merged.snapshotCachedAt, snapshot().snapshotCachedAt, 'partial refresh must not renew the old snapshot age');
});

test('a complete pulse can remove omitted collections and a fully refreshed snapshot gets a new age', () => {
  const cache = load();
  const original = snapshot();
  const merged = cache.mergeSnapshots(original, [
    { type: 'favorites', id: null, itemCount: 101, revision: 9, completeness: { confirmed: true }, items: [] },
    { type: 'playlists', id: 'p1', itemCount: 10, revision: 4, completeness: { confirmed: true }, items: [] },
  ], { removedKeys: ['albums:'], completeCatalog: true, now });
  assert.deepEqual([...merged.collections].map((collection) => cache.collectionKey(collection)).sort(), ['favorites:', 'playlists:p1']);
  assert.equal(merged.snapshotCachedAt, new Date(now).toISOString());
});

test('formatAge renders compact Russian labels', () => {
  const cache = load();
  assert.equal(cache.formatAge(new Date(now - 5 * 60000).toISOString(), now), '5 мин назад');
  assert.equal(cache.formatAge(new Date(now - 3 * hour).toISOString(), now), '3 ч назад');
  assert.equal(cache.formatAge(new Date(now).toISOString(), now), 'только что');
  assert.equal(cache.formatAge(new Date(now + hour).toISOString(), now), 'нет данных');
});
