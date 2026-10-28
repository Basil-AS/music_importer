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
  completeness: { confirmed: true },
  collections: [
    { type: 'favorites', id: null, itemCount: 100, completeness: { confirmed: true }, items: [] },
    { type: 'playlists', id: 'p1', itemCount: 10, revision: 4, completeness: { confirmed: true }, items: [] },
    { type: 'albums', id: null, itemCount: 5, completeness: { confirmed: true }, items: [] },
  ],
  ...overrides,
});

test('evaluate distinguishes missing, fresh, check and stale snapshots', () => {
  const cache = load();
  assert.equal(cache.evaluate({ now }), 'missing');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot(), lastCheckedAt: new Date(now - 60000).toISOString(), now }), 'fresh');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot(), now }), 'check');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot({ completeness: { confirmed: false } }), now }), 'stale');
  assert.equal(cache.evaluate({ cachedSnapshot: snapshot({ exportedAt: new Date(now - 8 * 24 * hour).toISOString() }), now }), 'stale');
});

test('diffAgainstPulse re-reads only changed, new or unconfirmed collections', () => {
  const cache = load();
  const summary = cache.summarizeSnapshot(snapshot());
  const same = cache.diffAgainstPulse(summary, { collections: [
    { type: 'favorites', id: null, itemCount: 100 }, { type: 'playlists', id: 'p1', itemCount: 10, revision: 4 }, { type: 'albums', id: null, itemCount: 5 },
  ] });
  assert.equal(same.unchanged, true);
  const changed = cache.diffAgainstPulse(summary, { collections: [
    { type: 'favorites', id: null, itemCount: 101 }, { type: 'playlists', id: 'p1', itemCount: 10, revision: 5 }, { type: 'playlists', id: 'p2', itemCount: 3 },
  ] });
  assert.deepEqual([...changed.reread].sort(), ['favorites:', 'playlists:p1', 'playlists:p2']);
  assert.deepEqual([...changed.removed], ['albums:']);
});

test('mergeSnapshots keeps the old confirmed copy when a re-read is unconfirmed', () => {
  const cache = load();
  const merged = cache.mergeSnapshots(snapshot(), [
    { type: 'favorites', id: null, itemCount: 101, completeness: { confirmed: false }, items: [] },
    { type: 'playlists', id: 'p2', itemCount: 3, completeness: { confirmed: true }, items: [] },
  ], ['albums:']);
  const byKey = Object.fromEntries(merged.collections.map((collection) => [cache.collectionKey(collection), collection]));
  assert.equal(byKey['favorites:'].itemCount, 100);
  assert.ok(byKey['playlists:p2']);
  assert.equal(byKey['albums:'], undefined);
  assert.equal(merged.completeness.confirmed, true);
});

test('formatAge renders compact Russian labels', () => {
  const cache = load();
  assert.equal(cache.formatAge(new Date(now - 5 * 60000).toISOString(), now), '5 мин назад');
  assert.equal(cache.formatAge(new Date(now - 3 * hour).toISOString(), now), '3 ч назад');
  assert.equal(cache.formatAge(new Date(now).toISOString(), now), 'только что');
});
