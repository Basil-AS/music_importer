const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadCache() {
  const context = { window: {}, Map, Date, String, Array, Number, JSON, Promise };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/match-cache.js'), 'utf8'), context);
  return context.window.MusicMatchCache;
}

test('local match cache keys include target and Apple storefront', () => {
  const cache = loadCache();
  const track = { title: 'ВРЕМЯ!', artist: 'Моя Мишель', album: 'Кино', durationMs: 210000, isrc: '' };
  assert.equal(cache.keyFor(track, 'apple-music', 'us'), cache.keyFor({ ...track, title: 'время' }, 'apple-music', 'US'));
  assert.notEqual(cache.keyFor(track, 'apple-music', 'US'), cache.keyFor(track, 'apple-music', 'GB'));
  assert.notEqual(cache.keyFor(track, 'apple-music', 'US', false), cache.keyFor(track, 'apple-music', 'US', true));
  assert.notEqual(cache.keyFor(track, 'apple-music', 'US'), cache.keyFor(track, 'spotify'));
});

test('local match cache stores only automatic catalog candidates and can be cleared', async () => {
  const cache = loadCache();
  const track = {
    title: 'Время', artist: 'Моя Мишель', album: 'Кино', durationMs: 210000,
    autoMatched: true, matchConfidence: 0.98,
    match: { trackId: 'target-1', trackName: 'Vremya', artistName: 'Moya Mishel', collectionName: 'Kino', trackTimeMillis: 210000, trackViewUrl: 'https://example.test/track/1' },
  };
  assert.equal(await cache.putAutomatic([track], 'spotify'), 1);
  const found = await cache.getMany([track], 'spotify');
  assert.equal(found.size, 1);
  assert.equal(found.get(cache.keyFor(track, 'spotify')).candidate.trackId, 'target-1');
  assert.equal(found.get(cache.keyFor(track, 'spotify')).candidate.trackViewUrl, 'https://example.test/track/1');
  assert.equal(await cache.putAutomatic([{ ...track, autoMatched: false }], 'spotify'), 0);
  await cache.clear();
  assert.equal((await cache.getMany([track], 'spotify')).size, 0);
});

test('Apple preview cache entries are never reused for account catalog IDs', async () => {
  const cache = loadCache();
  const track = {
    title: 'Song', artist: 'Artist', album: 'Album', durationMs: 180000,
    autoMatched: true, matchConfidence: 0.98, match: { trackId: 'preview-id', trackName: 'Song', artistName: 'Artist' },
  };
  await cache.putAutomatic([track], 'apple-music', 'US', false);
  assert.equal((await cache.getMany([track], 'apple-music', 'US', false)).size, 1);
  assert.equal((await cache.getMany([track], 'apple-music', 'US', true)).size, 0);
});

test('manual search text is excluded from automatic cache identity', () => {
  const cache = loadCache();
  assert.equal(cache.keyFor({ title: 'Track', artist: 'Artist', manualQuery: true }, 'zvuk'), '');
});
