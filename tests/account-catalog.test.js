const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function loadAccountCatalog() {
  const context = { window: {}, String, Number, Array, Map, Set, Object };
  vm.runInNewContext(fs.readFileSync(require.resolve('../demo/account-catalog.js'), 'utf8'), context);
  return context.window.MusicAccountCatalog;
}

test('complete target snapshots index favorite and playlist tracks by exact ISRC for every provider', () => {
  const accountCatalog = loadAccountCatalog();
  const fixtures = [
    ['apple-music', { catalogId: 'catalog-apple-1', id: 'library-apple-1', title: 'Song', artist: 'Artist', isrc: 'US-ABC-1234567' }],
    ['spotify', { id: 'spotify:track:1', title: 'Song', artists: [{ name: 'Artist' }], isrc: 'USABC1234567' }],
    ['yandex-music', { id: 'yandex-1', title: 'Song', artists: ['Artist'], isrc: 'USABC1234567' }],
    ['zvuk', { id: 'zvuk-1', title: 'Song', artists: [{ title: 'Artist' }], isrc: 'USABC1234567' }],
  ];

  for (const [provider, sourceTrack] of fixtures) {
    const snapshotTrack = provider === 'apple-music'
      ? sourceTrack
      : sourceTrack;
    const index = accountCatalog.buildIndex({
      service: provider,
      completeness: { confirmed: true },
      tracks: [],
      playlists: [{ tracks: [snapshotTrack, snapshotTrack] }],
    }, provider);
    const candidates = accountCatalog.findByISRC(index, { isrc: 'USABC1234567' });
    assert.equal(candidates.length, 1, provider);
    assert.equal(candidates[0].isrc, 'USABC1234567', provider);
    assert.equal(candidates[0].trackId, provider === 'apple-music' ? 'catalog-apple-1' : sourceTrack.id, provider);
    assert.equal(candidates[0].artistName, 'Artist', provider);
  }
});

test('account catalog index refuses incomplete snapshots and never guesses without ISRC', () => {
  const accountCatalog = loadAccountCatalog();
  const snapshot = {
    service: 'spotify',
    completeness: { confirmed: false },
    tracks: [{ id: 'spotify:track:1', title: 'Song', artists: ['Artist'], isrc: 'USABC1234567' }],
    playlists: [],
  };
  const index = accountCatalog.buildIndex(snapshot, 'spotify');
  assert.deepEqual(Array.from(index.keys()), []);
  assert.equal(accountCatalog.findByISRC(index, { title: 'Song', artist: 'Artist' }).length, 0);
});
