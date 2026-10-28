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

test('local catalog cache stores bounded candidates, preserves Yandex album IDs, and can be cleared', async () => {
  const cache = loadCache();
  const track = {
    title: 'Время', artist: 'Моя Мишель', album: 'Кино', durationMs: 210000,
    searched: true, matches: [
      { trackId: 'target-1', albumId: 'album-1', trackName: 'Vremya', artistName: 'Moya Mishel', collectionName: 'Kino', trackTimeMillis: 210000, trackViewUrl: 'https://example.test/track/1' },
      { trackId: 'target-2', albumId: 'album-2', trackName: 'Время (Live)', artistName: 'Моя Мишель', collectionName: 'Live', trackTimeMillis: 220000 },
    ],
  };
  assert.equal(await cache.putSearchResults([track], 'yandex-music'), 1);
  const found = await cache.getMany([track], 'spotify');
  assert.equal(found.size, 0);
  const yandexResults = await cache.getMany([track], 'yandex-music');
  assert.equal(yandexResults.size, 1);
  assert.equal(yandexResults.get(cache.keyFor(track, 'yandex-music')).candidates.length, 2);
  assert.equal(yandexResults.get(cache.keyFor(track, 'yandex-music')).candidates[0].albumId, 'album-1');
  assert.equal(yandexResults.get(cache.keyFor(track, 'yandex-music')).resultKind, 'candidates');
  assert.equal(yandexResults.get(cache.keyFor(track, 'yandex-music')).expiresAt - yandexResults.get(cache.keyFor(track, 'yandex-music')).updatedAt, 30 * 24 * 60 * 60 * 1000);
  assert.equal(await cache.putSearchResults([{ ...track, manualQuery: true }], 'yandex-music'), 0);
  assert.equal(await cache.putSearchResults([{ ...track, searchError: true }], 'yandex-music'), 0);
  await cache.clear();
  assert.equal((await cache.getMany([track], 'yandex-music')).size, 0);
});

test('local catalog cache keeps successful no-result searches briefly', async () => {
  const cache = loadCache();
  const track = { title: 'Unknown track', artist: 'Unknown artist', searched: true, matches: [] };
  assert.equal(await cache.putSearchResults([track], 'spotify'), 1);
  const found = await cache.getMany([track], 'spotify');
  assert.equal(found.size, 1);
  assert.deepEqual(Array.from(found.get(cache.keyFor(track, 'spotify')).candidates), []);
  assert.equal(found.get(cache.keyFor(track, 'spotify')).resultKind, 'no-results');
  assert.equal(found.get(cache.keyFor(track, 'spotify')).expiresAt - found.get(cache.keyFor(track, 'spotify')).updatedAt, 7 * 24 * 60 * 60 * 1000);
});

test('local catalog cache drops failed and manually edited searches', async () => {
  const cache = loadCache();
  const track = { title: 'Song', artist: 'Artist', searched: true, matches: [] };
  assert.equal(await cache.putSearchResults([{ ...track, searchError: true }], 'spotify'), 0);
  assert.equal(await cache.putSearchResults([{ ...track, manualQuery: true }], 'spotify'), 0);
});

test('cached result rows keep their original target-scoped identity', async () => {
  const cache = loadCache();
  const track = {
    title: 'Время', artist: 'Моя Мишель', album: 'Кино', durationMs: 210000, searched: true,
    matches: [{ trackId: 'target-1', albumId: 'album-1', trackName: 'Vremya', artistName: 'Moya Mishel', collectionName: 'Kino', trackTimeMillis: 210000, trackViewUrl: 'https://example.test/track/1' }],
  };
  assert.equal(await cache.putSearchResults([track], 'spotify'), 1);
  const found = await cache.getMany([track], 'spotify');
  assert.equal(found.size, 1);
  assert.equal(found.get(cache.keyFor(track, 'spotify')).candidates[0].trackId, 'target-1');
  assert.equal(found.get(cache.keyFor(track, 'spotify')).candidates[0].trackViewUrl, 'https://example.test/track/1');
  await cache.clear();
  assert.equal((await cache.getMany([track], 'spotify')).size, 0);
});

test('Apple preview cache entries are never reused for account catalog IDs', async () => {
  const cache = loadCache();
  const track = {
    title: 'Song', artist: 'Artist', album: 'Album', durationMs: 180000, searched: true,
    matches: [{ trackId: 'preview-id', trackName: 'Song', artistName: 'Artist' }],
  };
  await cache.putSearchResults([track], 'apple-music', 'US', false);
  assert.equal((await cache.getMany([track], 'apple-music', 'US', false)).size, 1);
  assert.equal((await cache.getMany([track], 'apple-music', 'US', true)).size, 0);
});

test('manual search text is excluded from automatic cache identity', () => {
  const cache = loadCache();
  assert.equal(cache.keyFor({ title: 'Track', artist: 'Artist', manualQuery: true }, 'zvuk'), '');
});

test('manual match and exclusion decisions persist locally with source and target scope', async () => {
  const cache = loadCache();
  const track = { title: 'Track', artist: 'Artist', album: 'Album', durationMs: 180000, manualQuery: true };
  const sourceProvider = 'apple-music';
  const decisionKey = cache.decisionKeyFor(track, 'yandex-music', '', false, sourceProvider);
  assert.ok(decisionKey);
  assert.equal(await cache.putDecision(track, 'yandex-music', { selected: true, trackId: 'ym-42' }, '', false, sourceProvider), true);
  let decisions = await cache.getDecisions([track], 'yandex-music', '', false, sourceProvider);
  assert.equal(decisions.get(decisionKey).targetTrackId, 'ym-42');
  assert.equal(decisions.get(decisionKey).selected, true);
  assert.equal((await cache.getDecisions([track], 'spotify', '', false, sourceProvider)).size, 0);
  assert.equal((await cache.getDecisions([track], 'yandex-music', '', false, 'spotify')).size, 0);
  assert.equal(await cache.putDecision(track, 'yandex-music', { selected: false, trackId: 'ym-42' }, '', false, sourceProvider), true);
  decisions = await cache.getDecisions([track], 'yandex-music', '', false, sourceProvider);
  assert.equal(decisions.get(decisionKey).selected, false);
  assert.equal(decisions.get(decisionKey).targetTrackId, 'ym-42');
  assert.equal(await cache.putDecision(track, 'yandex-music', { selected: false }, '', false, sourceProvider), true);
  decisions = await cache.getDecisions([track], 'yandex-music', '', false, sourceProvider);
  assert.equal(decisions.get(decisionKey).targetTrackId, null);
  assert.equal(await cache.putDecision(track, 'yandex-music', { selected: true }, '', false, sourceProvider), false);
  assert.equal(await cache.count(), 1);
  await cache.clear();
  assert.equal((await cache.getDecisions([track], 'yandex-music', '', false, sourceProvider)).size, 0);
});

test('playlist inclusion decisions are stored per occurrence while favorite identity remains per track', () => {
  const cache = loadCache();
  const base = { title: 'Track', artist: 'Artist', sourceId: 'source-track', sourceCollectionType: 'playlists' };
  const first = { ...base, sourceCollectionId: 'playlist-a', sourcePosition: 0 };
  const repeated = { ...base, sourceCollectionId: 'playlist-a', sourcePosition: 3 };
  const otherPlaylist = { ...base, sourceCollectionId: 'playlist-b', sourcePosition: 0 };
  const firstKey = cache.decisionKeyFor(first, 'spotify', '', false, 'zvuk');
  assert.notEqual(firstKey, cache.decisionKeyFor(repeated, 'spotify', '', false, 'zvuk'));
  assert.notEqual(firstKey, cache.decisionKeyFor(otherPlaylist, 'spotify', '', false, 'zvuk'));
  assert.equal(firstKey, cache.decisionKeyFor(first, 'spotify', '', false, 'zvuk'));

  const favoriteA = { ...base, sourceCollectionType: 'favorites' };
  const favoriteB = { ...base, sourceCollectionType: 'favorites' };
  assert.equal(cache.decisionKeyFor(favoriteA, 'spotify', '', false, 'zvuk'), cache.decisionKeyFor(favoriteB, 'spotify', '', false, 'zvuk'));
});
